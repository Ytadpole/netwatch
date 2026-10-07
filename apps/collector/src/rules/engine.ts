/** 规则引擎(§6,Phase 3 第一版三条规则):订阅事件流 → 阈值/首见/白名单判定 → 告警入库 + 通知 */

import type { TrafficEvent } from "@netwatch/shared";
import { isLan, isLoopback } from "../aggregate.js";
import type { EnrichedEvent } from "../enrich.js";
import type { Store } from "../store.js";
import type { RulesConfig } from "./config.js";
import type { Notifier } from "./notify.js";

export type AlertRule =
  | "new-destination"
  | "volume-threshold"
  | "unknown-process"
  | "beacon"
  /** 学习型分析器(rules/baseline.ts)产出,非事件规则 */
  | "baseline-anomaly";
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
    /** 进程 exe 落在可疑路径(§11 告警升级时标注) */
    suspiciousPath?: string;
  };
}

export interface ProcessMeta {
  exePath: string;
  suspicious: boolean;
}

export interface RuleEngineOptions {
  /** 采样间隔秒(nethogs -d),unknown-process 的连续窗口判定用 */
  intervalSec?: number;
  /** 进程画像回调(§11):命中可疑路径的告警升级(info→warn/warn→high)+ detail 标注 */
  processMeta?: (pid: number | null, process: string) => ProcessMeta | null;
}

/** 同一规则键的告警冷却,防止刷屏 */
const COOLDOWN_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
/** 冷启动首屏窗口:窗口内遇到的公网目的地视为存量流量,不触发 new-destination(与聚合器 baseline 同理) */
const BASELINE_MS = 3_000;

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

interface Delta {
  at: number;
  sent: number;
}

export class RuleEngine {
  private readonly intervalSec: number;
  /** 首个事件的时刻:冷启动 baseline 窗口的锚点 */
  private firstEventAt: number | null = null;
  /** 本次运行内已告警过的目的 IP(new-destination 只告一次) */
  private readonly alertedDestinations = new Set<string>();
  private readonly lastAlertAt = new Map<string, number>();
  /** 进程 → 1h 内上传增量环(体量规则) */
  private readonly flowRing = new Map<string, Delta[]>();
  private readonly unknownRing: Delta[] = [];
  /** 心跳检测:「进程|目的地」→ 窗口内上传增量环(§11 第 4 条) */
  private readonly beaconRing = new Map<string, Delta[]>();

  constructor(
    private readonly store: Store | null,
    private config: RulesConfig,
    private readonly notifiers: Notifier[] = [],
    private readonly opts: RuleEngineOptions = {},
  ) {
    this.intervalSec = opts.intervalSec ?? 2;
  }

  /** 配置热更新(SIGHUP / Web 端改白名单后触发) */
  updateConfig(config: RulesConfig): void {
    this.config = config;
  }

  /** 处理一个事件,返回本次触发的告警(副作用:入库 + 通知) */
  process(e: TrafficEvent): Alert[] {
    this.firstEventAt ??= e.at;
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
      const bc = this.checkBeacon(e);
      if (bc !== null) alerts.push(bc);
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
    if ((e as EnrichedEvent).transit === true) {
      return null; // transit 代理进程的出站:告警应归因到背后的应用,当前数据做不到(§3.3.1);volume 规则仍生效
    }
    if (this.firstEventAt !== null && e.at - this.firstEventAt < BASELINE_MS) {
      this.alertedDestinations.add(e.remoteIp); // 冷启动首屏批:存量目的地静默(部署瞬间不弹一波通知)
      return null;
    }
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

  /** §11 第 4 条:心跳式外联 —— 同进程对同一公网目的地,窗口内反复小包上传、间隔规律且持续足够久 */
  private checkBeacon(e: Extract<TrafficEvent, { kind: "flow" }>): Alert | null {
    const cfg = this.config.beacon;
    if (!cfg.enabled) return null;
    if (isLoopback(e.remoteIp) || isLan(e.remoteIp)) return null; // 只盯公网直连
    if (this.whitelisted(e.process, e.remoteIp)) return null;
    const key = `${e.process}|${e.remoteIp}`;
    const ring = this.beaconRing.get(key) ?? [];
    ring.push({ at: e.at, sent: e.sentBytes });
    const windowMs = cfg.windowMin * 60_000;
    while (ring.length > 0 && ring[0]!.at < e.at - windowMs) ring.shift();
    this.beaconRing.set(key, ring);
    if (ring.length < cfg.minSamples) return null; // 采样不足,无从谈节奏
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (last.at - first.at < cfg.minSpanMs) return null; // 模式尚未持续足够久
    const total = ring.reduce((s, d) => s + d.sent, 0);
    const avg = total / ring.length;
    if (avg > cfg.maxAvgBytes) return null; // 体量传输不是心跳
    const gaps: number[] = [];
    for (let i = 1; i < ring.length; i++) gaps.push(ring[i]!.at - ring[i - 1]!.at);
    const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (meanGap > cfg.maxMeanGapMs) return null; // 太稀疏
    const maxGap = Math.max(...gaps);
    const minGap = Math.min(...gaps);
    if ((maxGap - minGap) / meanGap > cfg.gapJitter) return null; // 间隔不规律
    if (this.isCooling(`beacon|${key}`, e.at)) return null;
    const jitterPct = Math.round(((maxGap - minGap) / meanGap) * 100);
    return this.emit(
      { at: e.at, rule: "beacon", severity: "info", detail: {
        message: `${e.process} 对 ${e.remoteIp}:${e.remotePort} 呈心跳式外联:${cfg.windowMin} 分钟窗口内 ${ring.length} 次小包上传(均值 ${Math.round(avg)} B/次,间隔抖动 ${jitterPct}%)`,
        process: e.process,
        pid: e.pid,
        remoteIp: e.remoteIp,
        remotePort: e.remotePort,
        windowSentBytes: total,
        windowSec: cfg.windowMin * 60,
      } },
      `beacon|${key}`,
    );
  }

  private emit(alert: Alert, cooldownKey: string): Alert {
    // §11 告警升级:进程 exe 落在可疑路径 → info→warn / warn→high,detail 标注路径
    const meta =
      this.opts.processMeta !== undefined && alert.detail.process !== undefined
        ? this.opts.processMeta(alert.detail.pid ?? null, alert.detail.process)
        : null;
    const out =
      meta !== null && meta.suspicious
        ? {
            ...alert,
            severity: (alert.severity === "info" ? "warn" : "high") as Alert["severity"],
            detail: {
              ...alert.detail,
              suspiciousPath: meta.exePath,
              message: `${alert.detail.message}(⚠ 可疑路径:${meta.exePath})`,
            },
          }
        : alert;
    this.lastAlertAt.set(cooldownKey, out.at);
    this.store?.insertAlert(out);
    for (const n of this.notifiers) n.send(out);
    return out;
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
