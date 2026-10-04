import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TrafficEvent, TrafficSource, TrafficSourceCapabilities } from "@netwatch/shared";

const execFileP = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 致命错误(ss 不存在等):不进入重试循环,由 CLI 直接呈现给用户 */
export class SsSourceError extends Error {}

export interface SsSourceOptions {
  /** 轮询间隔秒(默认 2,对齐 nethogs -d 的节奏) */
  delaySec?: number;
}

/** 单条连接的累计字节(内核计数器) */
interface Counters {
  sent: number;
  recv: number;
}

/**
 * Linux 主采集源(design.md §3.1,Phase 0 采样定稿):
 * 每 delaySec 执行 `ss -tinp state established`,把每条 TCP 连接的
 * (远端, 进程, 字节差)换算成 TrafficEvent。
 *  - bytes_sent/bytes_received 为**每连接累计值**,相邻两拍做差即窗口增量;
 *  - 连接首次出现仅建基线不发事件(避免把历史累计当成当拍上传);
 *  - 连接消失即从跟踪表移除(两次轮询间的短连接会漏——已知局限);
 *  - 无 users: 归属的连接 → unknown-flow(保留远端地址);
 *  - root 下可见全量进程;非 root 只有自己用户的进程有归属,其余进 unknown-flow。
 */
export class SsSource implements TrafficSource {
  readonly capabilities: TrafficSourceCapabilities = { perProcessBytes: true, dnsObservation: true };

  private readonly delaySec: number;
  private stopping = false;
  /** 连接键 → 上一拍累计字节 */
  private readonly prev = new Map<string, Counters>();

  constructor(opts: SsSourceOptions = {}) {
    this.delaySec = opts.delaySec ?? 2;
  }

  async *events(): AsyncGenerator<TrafficEvent> {
    // 首拍只建基线(连接的累计值可能是历史长连接的大数)
    let first = true;
    while (!this.stopping) {
      const at = Date.now();
      try {
        const out = await this.poll(at, first);
        first = false;
        for (const ev of out) yield ev;
      } catch (err) {
        if (this.stopping) return;
        if (err instanceof SsSourceError) throw err;
        // 单拍失败(瞬时空洞):下一拍继续,prev 未更新不会产生错误增量
      }
      if (this.stopping) return;
      await sleep(this.delaySec * 1_000);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
  }

  private async poll(at: number, baseline: boolean): Promise<TrafficEvent[]> {
    let stdout: string;
    try {
      ({ stdout } = await execFileP("ss", ["-tinp", "state", "established"], { maxBuffer: 16 * 1024 * 1024 }));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new SsSourceError(`ss 启动失败:未找到 ss 命令(iproute2)`);
      }
      throw err;
    }
    return parseSsSnapshot(stdout, this.prev, at, baseline);
  }
}

const SOCKET_RE = /^\s*\d+\s+\d+\s+(\S+)\s+(\S+)(\s+users:\(\((.*)\)\))?/;
const USERS_RE = /"([^"]*)",pid=(\d+)/;
const BYTES_SENT_RE = /bytes_sent:(\d+)/;
const BYTES_RECV_RE = /bytes_received:(\d+)/;

/** "192.168.1.8:43916" / "[fe80::1%eth0]:1234" → { addr, port } */
function splitAddrPort(s: string): { addr: string; port: number } {
  const i = s.lastIndexOf(":");
  return { addr: s.slice(0, i), port: Number(s.slice(i + 1)) };
}

/**
 * 解析一拍 ss 输出并与 prev 做差,产出事件;同时维护 prev(移除已消失的连接)。
 * @param baseline true = 只建基线不产出(首拍)
 */
export function parseSsSnapshot(
  text: string,
  prev: Map<string, Counters>,
  at: number,
  baseline: boolean,
): TrafficEvent[] {
  const events: TrafficEvent[] = [];
  const seen = new Set<string>();
  let pending: { key: string; remoteIp: string; remotePort: number; process: string | null; pid: number | null } | null = null;

  for (const rawLine of text.split("\n")) {
    if (rawLine.startsWith("Recv-Q") || rawLine.trim() === "") continue;

    const socket = SOCKET_RE.exec(rawLine);
    if (socket !== null) {
      const local = splitAddrPort(socket[1]!);
      const peer = splitAddrPort(socket[2]!);
      const users = socket[4];
      let process: string | null = null;
      let pid: number | null = null;
      if (users !== undefined) {
        const u = USERS_RE.exec(users);
        if (u !== null) {
          process = u[1]!;
          pid = Number(u[2]);
        }
      }
      pending = { key: `${local.addr}:${local.port}>${peer.addr}:${peer.port}`, remoteIp: peer.addr, remotePort: peer.port, process, pid };
      continue;
    }

    if (pending === null) continue;
    const sent = BYTES_SENT_RE.exec(rawLine);
    const recv = BYTES_RECV_RE.exec(rawLine);
    if (sent === null && recv === null) continue; // 信息行不含计数的怪行,跳过
    const cSent = sent !== null ? Number(sent[1]) : 0;
    const cRecv = recv !== null ? Number(recv[1]) : 0;
    seen.add(pending.key);

    const before = prev.get(pending.key);
    prev.set(pending.key, { sent: cSent, recv: cRecv });
    if (!baseline && before !== undefined) {
      const dSent = Math.max(0, cSent - before.sent);
      const dRecv = Math.max(0, cRecv - before.recv);
      if (dSent > 0 || dRecv > 0) {
        if (pending.process !== null && pending.pid !== null) {
          events.push({ kind: "flow", pid: pending.pid, process: pending.process, remoteIp: pending.remoteIp, remotePort: pending.remotePort, sentBytes: dSent, recvBytes: dRecv, at });
        } else {
          events.push({ kind: "unknown-flow", remoteIp: pending.remoteIp, remotePort: pending.remotePort, sentBytes: dSent, recvBytes: dRecv, at });
        }
      }
    }
    pending = null;
  }

  for (const key of prev.keys()) {
    if (!seen.has(key)) prev.delete(key); // 连接已关闭,停止跟踪
  }
  return events;
}
