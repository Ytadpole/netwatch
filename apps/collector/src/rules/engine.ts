/** 规则引擎(§6,Phase 3 第一版三条规则):订阅事件流 → 阈值/首见/白名单判定 → 告警入库 + 通知 */

import type { TrafficEvent } from "@netwatch/shared";
import { isLan, isLoopback } from "../aggregate.js";
import type { Store } from "../store.js";
import type { RulesConfig } from "./config.js";
import type { Notifier } from "./notify.js";

export type AlertRule = "new-destination" | "volume-threshold" | "unknown-process";
export type AlertSeverity = "info" | "warn" | "high";

export interface Alert {
  at: number;
  rule: AlertRule;
  severity: AlertSeverity;
  detail: {
    message: string;
    process?: string;
    pid?: number | null;
    remoteIp?: string;
    remotePort?: number;
    /** 命中窗口内的上传量(体量类规则) */
    windowSentBytes?: number;
    windowSec?: number;
    thresholdBytes?: number;
  };
}

export interface RuleEngineOptions {
  /** 采样间隔秒(nethogs -d),unknown-process 的连续窗口判定用 */
  intervalSec?: number;
}

/** 同一规则键的告警冷却,防止刷屏 */
const COOLDOWN_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

interface Delta {
  at: number;
  sent: number;
}

export class RuleEngine {
  private readonly intervalSec: number;
  /** 本次运行内已告警过的目的 IP(new-destination 只告一次) */
  private readonly alertedDestinations = new Set<string>();
  private readonly lastAlertAt = new Map<string, number>();
  /** 进程 → 1h 内上传增量环(体量规则) */
  private readonly flowRing = new Map<string, Delta[]>();
  private readonly unknownRing: Delta[] = [];

  constructor(
    private readonly store: Store | null,
    private readonly config: RulesConfig,
    private readonly notifiers: Notifier[] = [],
    opts: RuleEngineOptions = {},
  ) {
    this.intervalSec = opts.intervalSec ?? 2;
  }

  /** 处理一个事件,返回本次触发的告警(副作用:入库 + 通知) */
  process(e: TrafficEvent): Alert[] {
    const alerts: Alert[] = [];
    if (e.kind === "flow") {
      const ring = this.flowRing.get(e.process) ?? [];
      ring.push({ at: e.at, sent: e.sentBytes });
      this.flowRing.set(e.process, ring);
      this.pruneRings(e.at);
      const nd = this.checkNewDestination(e);
      if (nd !== null) alerts.push(nd);
      const vt = this.checkVolume(e.process, e.at);
      if (vt !== null) alerts.push(vt);
    } else {
      this.unknownRing.push({ at: e.at, sent: e.sentBytes });
      this.pruneRings(e.at);
      const up = this.checkUnknown(e.at);
      if (up !== null) alerts.push(up);
    }
    return alerts; // 入库与通知在 emit() 内完成,不在这里重复
  }

  /** §6 规则一:已知进程首次向新公网 IP 上传(info;当分钟 >escalateBytesPerMin 升 warn) */
  private checkNewDestination(e: Extract<TrafficEvent, { kind: "flow" }>): Alert | null {
    const cfg = this.config.newDestination;
    if (!cfg.enabled) return null;
    if (isLoopback(e.remoteIp) || isLan(e.remoteIp)) return null; // 只盯公网目的地
    if (this.alertedDestinations.has(e.remoteIp)) return null;
    if (this.whitelisted(e.process, e.remoteIp)) return null;
    if (this.store?.destinationFirstSeen(e.remoteIp) != null) {
      this.alertedDestinations.add(e.remoteIp); // 存量目的地(重启前的首见已落库)
      return null;
    }
    this.alertedDestinations.add(e.remoteIp);
    const minuteSent = this.sentWithin(e.process, e.at - (e.at % 60_000));
    const escalated = minuteSent > cfg.escalateBytesPerMin;
    return this.emit(
      {
        at: e.at,
        rule: "new-destination",
        severity: escalated ? "warn" : "info",
        detail: {
          message: `${e.process} 首次向新公网目的地 ${e.remoteIp}:${e.remotePort} 上传${escalated ? `(当分钟已传 ${fmtMB(minuteSent)})` : ""}`,
          process: e.process,
          pid: e.pid,
          remoteIp: e.remoteIp,
          remotePort: e.remotePort,
        },
      },
      `new-destination|${e.process}|${e.remoteIp}`,
    );
  }

  /** §6 规则二:单进程上传量异常(100MB/10min 或 500MB/h,可配) */
  private checkVolume(process: string, at: number): Alert | null {
    const cfg = this.config.volumeThreshold;
    if (!cfg.enabled) return null;
    if (this.isCooling(`volume-threshold|${process}`, at)) return null;
    const ring = this.flowRing.get(process) ?? [];
    const sent10 = this.sumWithin(ring, at - 10 * 60_000);
    const sent60 = this.sumWithin(ring, at - HOUR_MS);
    if (sent10 > cfg.bytesPer10min) {
      return this.emit(
        { at, rule: "volume-threshold", severity: "warn", detail: {
          message: `${process} 10 分钟内上传 ${fmtMB(sent10)}(阈值 ${fmtMB(cfg.bytesPer10min)})`,
          process, windowSentBytes: sent10, windowSec: 600, thresholdBytes: cfg.bytesPer10min,
        } },
        `volume-threshold|${process}`,
      );
    }
    if (sent60 > cfg.bytesPerHour) {
      return this.emit(
        { at, rule: "volume-threshold", severity: "warn", detail: {
          message: `${process} 1 小时内上传 ${fmtMB(sent60)}(阈值 ${fmtMB(cfg.bytesPerHour)})`,
          process, windowSentBytes: sent60, windowSec: 3600, thresholdBytes: cfg.bytesPerHour,
        } },
        `volume-threshold|${process}`,
      );
    }
    return null;
  }

  /** §6 规则三:归因不到进程的持续外传(连续 N 个采样窗口且 >bytesPerMin;滑窗近似实现) */
  private checkUnknown(at: number): Alert | null {
    const cfg = this.config.unknownProcess;
    if (!cfg.enabled) return null;
    if (this.isCooling("unknown-process", at)) return null;
    const spanMs = cfg.consecutiveWindows * this.intervalSec * 1000;
    const inSpan = this.unknownRing.filter((d) => d.at > at - spanMs);
    if (inSpan.length < cfg.consecutiveWindows) return null; // 覆盖不足 N 个窗口
    const first = inSpan[0];
    if (first === undefined) return null;
    const actualSpanMs = Math.max(1, at - first.at);
    const bytesPerMin = (this.sumWithin(inSpan, at - spanMs) / actualSpanMs) * 60_000;
    if (bytesPerMin < cfg.bytesPerMin) return null;
    return this.emit(
      { at, rule: "unknown-process", severity: "warn", detail: {
        message: `归因不到进程的外传持续 ≥${cfg.consecutiveWindows} 个采样窗口,约 ${fmtMB(bytesPerMin)}/min`,
        windowSentBytes: Math.round((bytesPerMin * actualSpanMs) / 60_000),
        windowSec: Math.round(actualSpanMs / 1000),
        thresholdBytes: cfg.bytesPerMin,
      } },
      "unknown-process",
    );
  }

  private emit(alert: Alert, cooldownKey: string): Alert {
    this.lastAlertAt.set(cooldownKey, alert.at);
    this.store?.insertAlert(alert);
    for (const n of this.notifiers) n.send(alert);
    return alert;
  }

  private isCooling(key: string, at: number): boolean {
    const last = this.lastAlertAt.get(key);
    return last !== undefined && at - last < COOLDOWN_MS;
  }

  private whitelisted(process: string, remoteIp: string): boolean {
    return this.config.whitelist.some((w) => w.process === process && (w.remoteIp === remoteIp || w.remoteIp === "*"));
  }

  private sentWithin(process: string, since: number): number {
    return this.sumWithin(this.flowRing.get(process) ?? [], since);
  }

  private sumWithin(deltas: Delta[], since: number): number {
    let sum = 0;
    for (const d of deltas) if (d.at >= since) sum += d.sent;
    return sum;
  }

  private pruneRings(at: number): void {
    const cutoff = at - HOUR_MS;
    for (const ring of this.flowRing.values()) {
      let drop = 0;
      while (drop < ring.length && ring[drop]!.at < cutoff) drop++;
      if (drop > 0) ring.splice(0, drop);
    }
    let drop = 0;
    while (drop < this.unknownRing.length && this.unknownRing[drop]!.at < cutoff) drop++;
    if (drop > 0) this.unknownRing.splice(0, drop);
  }
}
