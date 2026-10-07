/** 基线异常学习(§11,学习型,与事件规则并列):按「进程 × 目的地」的按日上传总量,
 *  与过去 N-1 天(不含今天)的活跃日均值/标准差比较;偏离 ≥ σ 且过绝对/相对护栏才告警。
 *  活跃日不足 minHistoryDays 时静默——真实部署约积累两周数据后开始工作。
 *  每 key 每日至多一条;冷却表在内存(重启后同日可能重报一次,可接受)。 */

import { isLan, isLoopback } from "../aggregate.js";
import type { Store } from "../store.js";
import type { RulesConfig } from "./config.js";
import type { Notifier } from "./notify.js";
import type { Alert, AlertSeverity } from "./engine.js";

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 本地时区日期(YYYY-MM-DD);与 Store.dailyFlowTotals 的 date(...,'localtime') 同界 */
function localDay(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 10);
}

const SEP = "\u001F";

interface KeyDaily {
  kind: "flow" | "unknown-flow";
  pid: number;
  process: string;
  remoteIp: string;
  /** 历史(不含今天)活跃日的按日上传量 */
  hist: Array<{ day: string; sent: number }>;
  today: number;
}

export class BaselineAnalyzer {
  private readonly lastAlertDay = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private config: RulesConfig,
    private readonly notifiers: Notifier[] = [],
  ) {}

  updateConfig(config: RulesConfig): void {
    this.config = config;
  }

  run(now: number): Alert[] {
    const cfg = this.config.baseline;
    if (!cfg.enabled) return [];
    const rows = this.store.dailyFlowTotals(now - cfg.historyDays * 86_400_000, now + 86_400_000);
    const today = localDay(now);
    const keys = new Map<string, KeyDaily>();
    for (const r of rows) {
      if (r.kind === "flow" && (isLoopback(r.remoteIp) || isLan(r.remoteIp))) continue; // 只盯公网直连
      const k = [r.kind, r.pid, r.process, r.remoteIp].join(SEP);
      let acc = keys.get(k);
      if (!acc) {
        acc = { kind: r.kind, pid: r.pid, process: r.process, remoteIp: r.remoteIp, hist: [], today: 0 };
        keys.set(k, acc);
      }
      if (r.day === today) acc.today += r.sent;
      else acc.hist.push({ day: r.day, sent: r.sent });
    }

    const alerts: Alert[] = [];
    for (const [k, acc] of keys) {
      if (acc.today < cfg.floorBytes) continue; // 小流量噪声
      if (this.lastAlertDay.get(k) === today) continue; // 每 key 每日至多一条
      if (this.whitelisted(acc.process, acc.remoteIp)) continue;
      const active = acc.hist.filter((h) => h.sent > 0);
      if (active.length < cfg.minHistoryDays) continue; // 数据不足,静默积累
      const mean = active.reduce((s, h) => s + h.sent, 0) / active.length;
      if (acc.today <= mean * cfg.minRatio) continue; // 相对护栏:防低方差误报
      const variance = active.reduce((s, h) => s + (h.sent - mean) ** 2, 0) / active.length;
      if (acc.today <= mean + cfg.sigma * Math.sqrt(variance)) continue; // σ 护栏
      const severity: AlertSeverity = "warn";
      const alert: Alert = {
        at: now,
        rule: "baseline-anomaly",
        severity,
        detail: {
          message: `${acc.process} 对 ${acc.remoteIp} 今日上传 ${fmtMB(acc.today)},显著高于近 ${cfg.historyDays - 1} 天的日常(活跃日均值 ${fmtMB(mean)}/日)`,
          process: acc.process,
          pid: acc.pid,
          remoteIp: acc.remoteIp,
          windowSentBytes: acc.today,
        },
      };
      this.lastAlertDay.set(k, today);
      this.store.insertAlert(alert);
      for (const n of this.notifiers) n.send(alert);
      alerts.push(alert);
    }
    return alerts;
  }

  private whitelisted(process: string, remoteIp: string): boolean {
    return this.config.whitelist.some((w) => w.process === process && (w.remoteIp === remoteIp || w.remoteIp === "*"));
  }
}
