import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { TrafficEvent, TrafficSource, TrafficSourceCapabilities } from "@netwatch/shared";
import { parseNethogsLine } from "./parse.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 致命错误(未安装 nethogs / 无 root 权限):不进入重试循环,由 CLI 直接呈现给用户 */
export class NethogsSourceError extends Error {}

export interface NethogsSourceOptions {
  /** 采样间隔(秒),即 nethogs -d */
  delaySec?: number;
}

/**
 * Linux 采集源:`nethogs -t` 子进程 → 行解析 → TrafficEvent(§3.1)。
 * 子进程管理:启动 / 崩溃退避重启 / SIGTERM 优雅退出;速率(KB/s)→ 窗口增量换算在解析器内。
 */
export class NethogsSource implements TrafficSource {
  readonly capabilities: TrafficSourceCapabilities = { perProcessBytes: true, dnsObservation: true };

  private readonly delaySec: number;
  private stopping = false;
  private child: ChildProcess | null = null;
  /** 最近一次解析统计(观测用,校准信号见 parse.ts) */
  lastStats = { skippedHeaders: 0, missingRemote: 0, unknown: 0 };

  constructor(opts: NethogsSourceOptions = {}) {
    this.delaySec = opts.delaySec ?? 2;
  }

  async *events(): AsyncGenerator<TrafficEvent> {
    let backoffMs = 1_000;
    while (!this.stopping) {
      let produced = 0;
      try {
        for await (const ev of this.runOnce()) {
          produced++;
          yield ev;
        }
      } catch (err) {
        if (this.stopping) return;
        if (err instanceof NethogsSourceError) throw err;
        // 子进程异常崩溃 → 退避重启
      }
      if (this.stopping) return;
      if (produced > 0) backoffMs = 1_000; // 之前跑正常过,重置退避
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  private async *runOnce(): AsyncGenerator<TrafficEvent> {
    const child = spawn("nethogs", ["-t", "-d", String(this.delaySec)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
    });
    // 启动失败(ENOENT 等)时 node 只发 'error' 不发 'close':
    // 统一走"记录错误 + resolve",避免未处理的 rejection 炸掉进程
    let failure: NethogsSourceError | null = null;
    const exited = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", (err) => {
        failure = new NethogsSourceError(`nethogs 启动失败:${err.message}(需要安装 nethogs 且以 root 运行)`);
        resolve();
      });
    });

    try {
      const rl = createInterface({ input: child.stdout! });
      for await (const line of rl) {
        const r = parseNethogsLine(line, this.delaySec, Date.now());
        this.lastStats.skippedHeaders += r.skippedHeaders;
        this.lastStats.missingRemote += r.missingRemote;
        this.lastStats.unknown += r.unknown;
        for (const ev of r.events) yield ev;
        if (this.stopping) break;
      }
    } catch (loopErr) {
      // 子进程根本没起来时,读流循环可能抛次生错误;真实原因以 failure 为准
      throw failure ?? (loopErr instanceof Error ? loopErr : new Error(String(loopErr)));
    } finally {
      if (!this.stopping && child.exitCode === null) child.kill("SIGTERM");
      this.child = null;
    }
    await exited;
    if (this.stopping) return;
    if (failure) throw failure;

    // 立刻退出且一行数据都没产出 → 视为致命(权限/安装问题),交给上层呈现
    if (stderrTail.length > 0 && /root|permission|cannot|failed/i.test(stderrTail)) {
      throw new NethogsSourceError(`nethogs 无法运行:${stderrTail.trim().split("\n").pop()}(采集端需要 root:用 sudo 运行)`);
    }
  }
}
