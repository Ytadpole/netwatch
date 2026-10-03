import type { TrafficEvent } from "@netwatch/shared";
import type { MinuteRow, DestinationSighting } from "./store.js";

/** 内存滚动窗口聚合(分钟桶 × 进程 × 目的地),Phase 1 形态;Phase 2 接 Store 落库 */

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

export interface ClosedMinute {
  minute: number;
  rows: MinuteRow[];
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
/** 键分隔符用单元分隔符:进程名可能含 "|" 等常规字符 */
const SEP = "\u001F";

function bucketKey(e: TrafficEvent): string {
  if (e.kind === "unknown-flow") return ["unknown", e.remoteIp, String(e.remotePort)].join(SEP);
  return ["flow", e.pid ?? "-", e.process, e.remoteIp, String(e.remotePort)].join(SEP);
}

interface KeyParts {
  kind: "flow" | "unknown-flow";
  pid: number | null;
  process: string;
  remoteIp: string;
  remotePort: number;
}

function parseKey(key: string): KeyParts {
  const p = key.split(SEP);
  if (p[0] === "unknown") {
    return { kind: "unknown-flow", pid: null, process: UNKNOWN_PROCESS, remoteIp: p[1] ?? "", remotePort: Number(p[2] ?? 0) };
  }
  return {
    kind: "flow",
    pid: p[1] === "-" ? null : Number(p[1]),
    process: p[2] ?? "",
    remoteIp: p[3] ?? "",
    remotePort: Number(p[4] ?? 0),
  };
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
  /** remoteIp → 事件时刻的首见;Phase 2 起 drainClosedMinutes 上报给 Store(存真实时刻) */
  private readonly destFirstSeen = new Map<string, number>();
  /** 启动首屏批里出现的目的地:存量流量,永远不标 NEW(与存储的首见时间无关) */
  private readonly baselineDests = new Set<string>();
  private readonly reportedDests = new Set<string>();
  /** 首个采样批的时间 */
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
      this.destFirstSeen.set(e.remoteIp, e.at);
      if (e.at - this.firstPushAt < 3_000) this.baselineDests.add(e.remoteIp);
    }
    this.recent.push({ key, at: e.at, sent: e.sentBytes, recv: e.recvBytes });
  }

  /**
   * 排空已关闭的分钟桶(分钟 < 当前分钟):交给 Store 落库,桶从内存移除。
   * newDestinations 里是尚未上报过的首见目的地,first_seen 为事件时刻而非落盘时刻。
   */
  drainClosedMinutes(now: number): { minutes: ClosedMinute[]; newDestinations: DestinationSighting[] } {
    const currentMinute = Math.floor(now / 60_000) * 60_000;
    const minutes: ClosedMinute[] = [];
    for (const [minute, bucket] of this.minuteBuckets) {
      if (minute >= currentMinute) continue;
      const rows: MinuteRow[] = [];
      for (const [key, entry] of bucket) {
        const k = parseKey(key);
        rows.push({
          kind: k.kind,
          pid: k.pid,
          process: k.process,
          remoteIp: k.remoteIp,
          remotePort: k.remotePort,
          sent: entry.sent,
          recv: entry.recv,
        });
      }
      minutes.push({ minute, rows });
      this.minuteBuckets.delete(minute);
    }
    minutes.sort((a, b) => a.minute - b.minute);

    const newDestinations: DestinationSighting[] = [];
    for (const [ip, firstSeen] of this.destFirstSeen) {
      if (!this.reportedDests.has(ip)) {
        this.reportedDests.add(ip);
        newDestinations.push({ remoteIp: ip, firstSeen });
      }
    }
    return { minutes, newDestinations };
  }

  snapshot(now: number = Date.now()): LiveSnapshot {
    this.pruneRecent(now);
    const windowSec = this.rateWindowMs / 1000;

    interface KeyRate extends KeyParts {
      sent: number;
      recv: number;
    }
    const byKey = new Map<string, KeyRate>();
    for (const d of this.recent) {
      let acc = byKey.get(d.key);
      if (!acc) {
        acc = { ...parseKey(d.key), sent: 0, recv: 0 };
        byKey.set(d.key, acc);
      }
      acc.sent += d.sent;
      acc.recv += d.recv;
    }

    const procMap = new Map<string, { info: { pid: number | null; process: string; unattributed: boolean }; sentRate: number; recvRate: number; dests: DestLive[] }>();
    let totalSent = 0;
    let totalRecv = 0;
    for (const acc of byKey.values()) {
      const sentRate = acc.sent / windowSec;
      const recvRate = acc.recv / windowSec;
      totalSent += acc.sent;
      totalRecv += acc.recv;
      const unattributed = acc.kind === "unknown-flow";
      const groupKey = unattributed ? UNKNOWN_PROCESS : `${acc.pid ?? "-"}|${acc.process}`;
      let proc = procMap.get(groupKey);
      if (!proc) {
        proc = {
          info: { pid: acc.pid, process: unattributed ? UNKNOWN_PROCESS : acc.process, unattributed },
          sentRate: 0,
          recvRate: 0,
          dests: [],
        };
        procMap.set(groupKey, proc);
      }
      proc.sentRate += sentRate;
      proc.recvRate += recvRate;
      proc.dests.push({
        remoteIp: acc.remoteIp,
        remotePort: acc.remotePort,
        sentRate,
        recvRate,
        share: 0,
        lan: isLan(acc.remoteIp),
        loopback: isLoopback(acc.remoteIp),
        isNew: this.isNewDestination(unattributed ? null : acc.remoteIp, now),
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

  /** 某分钟桶的上传/下载总量(核对用) */
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
    if (this.baselineDests.has(ip)) return false;
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
