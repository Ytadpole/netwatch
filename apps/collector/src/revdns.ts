/**
 * 反向 DNS 兜底(§3.3 优先级 3):对活跃远端 IP 做 PTR 解析得域名。
 * 正/负结果都缓存(TTL 内不重试),并发上限防止 DNS 风暴;解析器可注入(测试)。
 * 隐私边界(§9):这是普通 DNS 查询(设计明确允许的兜底),不是在线 GeoIP。
 */

import { reverse as systemReverse } from "node:dns/promises";

export type Resolver = (ip: string) => Promise<string[]>;

export interface ReverseDnsOptions {
  /** 缓存 TTL(正负结果相同),默认 6h */
  ttlMs?: number;
  /** 同时在途解析上限 */
  maxInFlight?: number;
  /** 单次解析超时 */
  timeoutMs?: number;
  /** 注入解析器(测试/未来替换为 DNS 观察缓存) */
  resolve?: Resolver;
}

interface Entry {
  /** null = 负缓存(无 PTR 或超时) */
  domain: string | null;
  resolvedAt: number;
}

export class ReverseDns {
  private readonly ttlMs: number;
  private readonly maxInFlight: number;
  private readonly timeoutMs: number;
  private readonly resolve: Resolver;

  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Set<string>();
  private readonly queue: string[] = [];

  constructor(opts: ReverseDnsOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 6 * 3_600_000;
    this.maxInFlight = opts.maxInFlight ?? 10;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.resolve = opts.resolve ?? systemReverse;
  }

  /** 事件侧调用:活跃 IP 进入解析队列;TTL 内已知(含负缓存)的直接跳过 */
  observe(ip: string): void {
    const hit = this.cache.get(ip);
    if (hit !== undefined && Date.now() - hit.resolvedAt < this.ttlMs) return;
    if (this.pending.has(ip) || this.queue.includes(ip)) return;
    this.queue.push(ip);
    this.pump();
  }

  /** 落库/展示侧调用:已解析的域名;无结果返回 undefined(表列留 NULL) */
  domainOf(ip: string): string | undefined {
    return this.cache.get(ip)?.domain ?? undefined;
  }

  /** 环内状态(观测用) */
  stats(): { cached: number; pending: number; queued: number } {
    return { cached: this.cache.size, pending: this.pending.size, queued: this.queue.length };
  }

  private pump(): void {
    while (this.pending.size < this.maxInFlight && this.queue.length > 0) {
      const ip = this.queue.shift()!;
      this.pending.add(ip);
      void this.resolveOne(ip);
    }
  }

  private async resolveOne(ip: string): Promise<void> {
    let domain: string | null = null;
    try {
      const names = await Promise.race([
        this.resolve(ip),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error(`reverse dns timeout: ${ip}`)), this.timeoutMs);
          t.unref();
        }),
      ]);
      domain = names[0] ?? null; // 多 PTR 罕见,取第一个
    } catch {
      domain = null; // 负缓存:无 PTR / 超时,TTL 内不重试
    } finally {
      this.pending.delete(ip);
      this.cache.set(ip, { domain, resolvedAt: Date.now() });
      this.pump();
    }
  }
}
