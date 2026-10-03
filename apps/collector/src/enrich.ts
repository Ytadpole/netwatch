/**
 * 富化器(§3.3.1,Phase 5):事件源 → 聚合/规则 之间的一层。
 * 不改变归因事实,只附加推断字段:
 *  - viaLocalProxy:remoteIp 是环回 → "应用→本地代理"一跳;
 *  - viaProxyTo:字节相关启发式关联出的真实远端(打在"应用→代理"事件上);
 *  - transit:本事件来自已确认的 transit 代理进程(代理→真实远端一跳)。
 * 关联是展示/告警层推断,原始事件的 pid/process/remoteIp/字节数一律不动。
 */

import type { TrafficEvent } from "@netwatch/shared";
import { isLoopback } from "./aggregate.js";

export interface ProxyEndpoint {
  remoteIp: string;
  remotePort: number;
}

/** 富化附加字段;transit/viaProxyTo 只会出现在 flow 事件上(optional,联合整体交叉) */
export type EnrichedEvent = TrafficEvent & {
  viaLocalProxy?: boolean;
  viaProxyTo?: ProxyEndpoint;
  transit?: boolean;
};

export interface EnricherOptions {
  /** 关联时间窗(毫秒) */
  matchWindowMs?: number;
  /** 字节数相对容差(0~1) */
  matchTolerance?: number;
  /** 确认 transit 进程所需的最少命中次数 */
  transitConfirmations?: number;
  /** 环缓冲保留时长(毫秒) */
  ringTtlMs?: number;
}

interface Leg {
  at: number;
  process: string;
  remoteIp: string;
  remotePort: number;
  sent: number;
  /** 已被消费,不再参与后续关联 */
  used?: boolean;
}

export interface EnrichStats {
  /** 已确认的 transit 代理进程 */
  transitProcesses: string[];
  /** 观测到的本地代理端口 */
  proxyPorts: number[];
  /** 成功关联的两跳对数 */
  associations: number;
}

export class Enricher {
  private readonly matchWindowMs: number;
  private readonly matchTolerance: number;
  private readonly transitConfirmations: number;
  private readonly ringTtlMs: number;

  /** 应用→环回端口 P 的一跳(等待与公网出站关联) */
  private readonly loopbackLegs: Leg[] = [];
  /** 代理→公网的一跳(尚未被确认是代理时先按普通公网事件暂存) */
  private readonly publicLegs: Leg[] = [];
  private readonly proxyPorts = new Set<number>();
  /** 进程 → 两跳命中次数 */
  private readonly transitVotes = new Map<string, number>();
  private confirmedTransit = new Set<string>();
  private associations = 0;

  constructor(opts: EnricherOptions = {}) {
    this.matchWindowMs = opts.matchWindowMs ?? 5_000;
    this.matchTolerance = opts.matchTolerance ?? 0.25;
    this.transitConfirmations = opts.transitConfirmations ?? 3;
    this.ringTtlMs = opts.ringTtlMs ?? 15_000;
  }

  process(e: TrafficEvent): EnrichedEvent {
    this.prune(e.at);
    if (e.kind !== "flow") return e;

    if (isLoopback(e.remoteIp)) {
      // 应用→本地代理一跳:记录代理端口,并尝试向"已见过的公网出站"做关联
      this.proxyPorts.add(e.remotePort);
      const leg: Leg = { at: e.at, process: e.process, remoteIp: e.remoteIp, remotePort: e.remotePort, sent: e.sentBytes };
      this.loopbackLegs.push(leg);
      const hit = this.match(this.publicLegs, leg);
      const out: EnrichedEvent = { ...e, viaLocalProxy: true };
      if (hit !== null) {
        out.viaProxyTo = { remoteIp: hit.remoteIp, remotePort: hit.remotePort };
        this.creditTransit(hit.process);
      }
      return out;
    }

    // 公网/局域网出站:尝试与 pending 的环回跳关联;已确认的 transit 进程直接标注
    const leg: Leg = { at: e.at, process: e.process, remoteIp: e.remoteIp, remotePort: e.remotePort, sent: e.sentBytes };
    const isTransit = this.confirmedTransit.has(e.process);
    const hit = this.match(this.loopbackLegs, leg);
    const out: EnrichedEvent = { ...e };
    if (hit !== null) {
      this.creditTransit(e.process);
      out.transit = true;
      leg.used = true; // 字节对应已被这次关联消费,不再匹配其他环回跳
    } else if (isTransit) {
      out.transit = true;
    }
    this.publicLegs.push(leg); // 代理出站也留在公网环,供迟到的应用跳关联(顺序不定,标注至少落在后到的一跳)
    return out;
  }

  stats(): EnrichStats {
    return {
      transitProcesses: [...this.confirmedTransit],
      proxyPorts: [...this.proxyPorts],
      associations: this.associations,
    };
  }

  /**
   * 在对方环里找字节相关的一条:环回跳在公网环里找代理出站;公网跳在环回环里找应用。
   * 同进程的候选一律跳过(自己→代理 与 自己→公网 直连不是两跳关系)。
   */
  private match(among: Leg[], leg: Leg): Leg | null {
    let best: Leg | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const cand of among) {
      if (cand.used) continue;
      if (Math.abs(cand.at - leg.at) > this.matchWindowMs) continue;
      if (cand.process === leg.process) continue;
      const diff = Math.abs(cand.sent - leg.sent) / Math.max(cand.sent, leg.sent, 1);
      if (diff > this.matchTolerance) continue;
      const score = diff + (this.confirmedTransit.has(cand.process) ? -0.1 : 0); // 已确认代理优先
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (best === null) return null;
    best.used = true;
    this.associations++;
    return best;
  }

  private creditTransit(process: string): void {
    const votes = (this.transitVotes.get(process) ?? 0) + 1;
    this.transitVotes.set(process, votes);
    if (votes >= this.transitConfirmations) this.confirmedTransit.add(process);
  }

  private prune(at: number): void {
    const cutoff = at - this.ringTtlMs;
    let drop = 0;
    while (drop < this.loopbackLegs.length && this.loopbackLegs[drop]!.at < cutoff) drop++;
    if (drop > 0) this.loopbackLegs.splice(0, drop);
    drop = 0;
    while (drop < this.publicLegs.length && this.publicLegs[drop]!.at < cutoff) drop++;
    if (drop > 0) this.publicLegs.splice(0, drop);
  }
}
