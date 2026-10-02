import type { TrafficEvent } from "@netwatch/shared";

/** 内存滚动窗口聚合(分钟桶 × 进程 × 目的地),Phase 1 形态;Phase 2 落 SQLite */

export interface DestLive {
  remoteIp: string;
  remotePort: number;
  sentRate: number; // B/s,速率窗口内的均值
  recvRate: number;
  /** 相对所属进程的上传占比(0~1) */
  share: number;
  lan: boolean;
  loopback: boolean;
  /** 目的地首见 5 分钟内(§5.1 的 NEW 徽标依据) */
  isNew: boolean;
}

export interface ProcessLive {
  process: string;
  pid: number | null;
  /** unknown-flow 汇总出的伪进程卡(§6:规则引擎单独盯它) */
  unattributed: boolean;
  sentRate: number;
  recvRate: number;
  /** 按上传速率降序 */
  destinations: DestLive[];
}

export interface LiveSnapshot {
  at: number;
  totalSentRate: number;
  totalRecvRate: number;
  /** 按上传速率降序;归因失败的伪进程卡固定排最后 */
  processes: ProcessLive[];
}

interface BucketEntry {
  sent: number;
  recv: number;
}

interface RecentDelta {
  key: string;
  at: number;
  sent: number;
  recv: number;
}

export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
}

export function isLan(ip: string): boolean {
  if (isLoopback(ip)) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!v4) return false; // IPv6 暂不判定
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const UNKNOWN_PROCESS = "(归因失败)";

function bucketKey(e: TrafficEvent): string {
  if (e.kind === "unknown-flow") return `unknown|${e.remoteIp}|${e.remotePort}`;
  return `flow|${e.pid ?? "-"}|${e.process}|${e.remoteIp}|${e.remotePort}`;
}

export interface AggregatorOptions {
  /** 分钟桶保留个数(内存滚动窗口) */
  minuteRetention?: number;
  /** 实时速率的滑动窗口(毫秒) */
  rateWindowMs?: number;
  /** 目的地"首见 NEW"窗口(毫秒,§5.1:5 分钟) */
  newDestWindowMs?: number;
}

export class RollingAggregator {
  private readonly minuteRetention: number;
  private readonly rateWindowMs: number;
  private readonly newDestWindowMs: number;

  private readonly minuteBuckets = new Map<number, Map<string, BucketEntry>>();
  private readonly recent: RecentDelta[] = [];
  /** remoteIp → 首见时刻;Phase 2 换 destinations 表 */
  private readonly destFirstSeen = new Map<string, number>();
  /** 首个采样批的时间;批内出现的目的地视为"既有",避免启动时满屏 NEW */
  private firstPushAt: number | null = null;

  constructor(opts: AggregatorOptions = {}) {
    this.minuteRetention = opts.minuteRetention ?? 120;
    this.rateWindowMs = opts.rateWindowMs ?? 10_000;
    this.newDestWindowMs = opts.newDestWindowMs ?? 5 * 60_000;
  }

  push(e: TrafficEvent): void {
    const minute = Math.floor(e.at / 60_000) * 60_000;
    const key = bucketKey(e);
    let bucket = this.minuteBuckets.get(minute);
    if (!bucket) {
      bucket = new Map();
      this.minuteBuckets.set(minute, bucket);
      this.pruneMinutes(minute);
    }
    const entry = bucket.get(key) ?? { sent: 0, recv: 0 };
    entry.sent += e.sentBytes;
    entry.recv += e.recvBytes;
    bucket.set(key, entry);

    if (e.kind === "flow" && !this.destFirstSeen.has(e.remoteIp)) {
      this.firstPushAt ??= e.at;
      const baseline = e.at - this.firstPushAt < 3_000;
      this.destFirstSeen.set(e.remoteIp, baseline ? e.at - this.newDestWindowMs : e.at);
    }
    this.recent.push({ key, at: e.at, sent: e.sentBytes, recv: e.recvBytes });
  }

  snapshot(now: number = Date.now()): LiveSnapshot {
    this.pruneRecent(now);
    const windowSec = this.rateWindowMs / 1000;

    interface KeyRate {
      sent: number;
      recv: number;
      sample: { kind: string; pid: number | null; process: string; remoteIp: string; remotePort: number };
    }
    const byKey = new Map<string, KeyRate>();
    for (const d of this.recent) {
      let acc = byKey.get(d.key);
      if (!acc) {
        acc = {
          sent: 0,
          recv: 0,
          sample: { kind: "", pid: null, process: "", remoteIp: "", remotePort: 0 },
        };
        byKey.set(d.key, acc);
      }
      acc.sent += d.sent;
      acc.recv += d.recv;
    }
    // recent 里只存了 key,进程/目的地信息从 key 反解(见 bucketKey 的分隔符约定)
    for (const [key, acc] of byKey) {
      const parts = key.split("|");
      if (parts[0] === "unknown") {
        acc.sample = { kind: "unknown-flow", pid: null, process: UNKNOWN_PROCESS, remoteIp: parts[1] ?? "", remotePort: Number(parts[2] ?? 0) };
      } else {
        acc.sample = {
          kind: "flow",
          pid: parts[1] === "-" ? null : Number(parts[1]),
          process: parts[2] ?? "",
          remoteIp: parts[3] ?? "",
          remotePort: Number(parts[4] ?? 0),
        };
      }
    }

    const procMap = new Map<string, { info: { pid: number | null; process: string; unattributed: boolean }; sentRate: number; recvRate: number; dests: DestLive[] }>();
    let totalSent = 0;
    let totalRecv = 0;
    for (const [key, acc] of byKey) {
      const s = acc.sample;
      const sentRate = acc.sent / windowSec;
      const recvRate = acc.recv / windowSec;
      totalSent += acc.sent;
      totalRecv += acc.recv;
      const unattributed = s.kind === "unknown-flow";
      const groupKey = unattributed ? UNKNOWN_PROCESS : `${s.pid ?? "-"}|${s.process}`;
      let proc = procMap.get(groupKey);
      if (!proc) {
        proc = {
          info: { pid: s.pid, process: unattributed ? UNKNOWN_PROCESS : s.process, unattributed },
          sentRate: 0,
          recvRate: 0,
          dests: [],
        };
        procMap.set(groupKey, proc);
      }
      proc.sentRate += sentRate;
      proc.recvRate += recvRate;
      proc.dests.push({
        remoteIp: s.remoteIp,
        remotePort: s.remotePort,
        sentRate,
        recvRate,
        share: 0,
        lan: isLan(s.remoteIp),
        loopback: isLoopback(s.remoteIp),
        isNew: this.isNewDestination(unattributed ? null : s.remoteIp, now),
      });
    }
    const processes = [...procMap.values()].map((p) => {
      p.dests.sort((a, b) => b.sentRate - a.sentRate);
      for (const d of p.dests) d.share = p.sentRate > 0 ? d.sentRate / p.sentRate : 0;
      return {
        process: p.info.process,
        pid: p.info.pid,
        unattributed: p.info.unattributed,
        sentRate: p.sentRate,
        recvRate: p.recvRate,
        destinations: p.dests,
      };
    });
    // unattributed(1) 排在后面:比较值 > 0 → a 沉底
    processes.sort((a, b) => Number(a.unattributed) - Number(b.unattributed) || b.sentRate - a.sentRate);

    return {
      at: now,
      totalSentRate: totalSent / windowSec,
      totalRecvRate: totalRecv / windowSec,
      processes,
    };
  }

  /** 某分钟桶的上传/下载总量(Phase 2 落库前的核对入口) */
  minuteTotals(minute: number): { sent: number; recv: number } {
    const bucket = this.minuteBuckets.get(Math.floor(minute / 60_000) * 60_000);
    if (!bucket) return { sent: 0, recv: 0 };
    let sent = 0;
    let recv = 0;
    for (const e of bucket.values()) {
      sent += e.sent;
      recv += e.recv;
    }
    return { sent, recv };
  }

  private isNewDestination(ip: string | null, now: number): boolean {
    if (ip === null) return false;
    const firstSeen = this.destFirstSeen.get(ip);
    return firstSeen !== undefined && now - firstSeen < this.newDestWindowMs;
  }

  private pruneRecent(now: number): void {
    const cutoff = now - this.rateWindowMs;
    let drop = 0;
    while (drop < this.recent.length && this.recent[drop]!.at < cutoff) drop++;
    if (drop > 0) this.recent.splice(0, drop);
  }

  private pruneMinutes(currentMinute: number): void {
    const cutoff = currentMinute - this.minuteRetention * 60_000;
    for (const m of this.minuteBuckets.keys()) {
      if (m < cutoff) this.minuteBuckets.delete(m);
    }
  }
}
