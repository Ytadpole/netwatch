import type { TrafficEvent } from "@netwatch/shared";

/**
 * nethogs -t 行解析。
 *
 * ⚠️ 校准点:Phase 0 采样尚未执行(等 `sudo bash docs/samples/run-spike.sh` 落地
 * docs/samples/nethogs.txt 后,以真实输出修订本文件,plan.md §Phase 0)。
 *
 * 目前的容错策略(基于 nethogs 0.8.x trace 模式的公开资料):
 * - "Refreshing:"/"Waiting..." 等头行跳过;
 * - 数据行前两列为 sent/received 速率(KB/s),按采样间隔换算为窗口内增量字节;
 * - 行内其余列尝试识别:PID(整数或 "?")、远端(ip:port / [v6]:port)、进程名;
 * - PID 缺失或程序名为 unknown-* 且行内有远端 → `unknown-flow`;
 * - 识别不出远端地址列的行 → 跳过并计数(计数通过 stats 返回,便于校准时发现)。
 */

export interface ParseResult {
  events: TrafficEvent[];
  /** 非数据行(头行等) */
  skippedHeaders: number;
  /** 数据行但缺远端地址列——校准信号:trace 行结构与本实现假设不符 */
  missingRemote: number;
  /** 归因失败行(unknown) */
  unknown: number;
}

const RATE_RE = /^\d+(\.\d+)?$/;
const IPV4_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/;
const IPV6_PORT = /^\[[0-9a-fA-F:.]+]:(\d{1,5})$/;
const UNKNOWN_NAME_RE = /^(unknown|\?\?|\?\?\?)/i;

interface Remote {
  ip: string;
  port: number;
}

function matchRemote(token: string): Remote | null {
  const v4 = IPV4_PORT.exec(token);
  if (v4) return { ip: v4[1]!, port: Number(v4[2]) };
  const v6 = IPV6_PORT.exec(token);
  if (v6) return { ip: token.slice(1, token.indexOf("]")), port: Number(v6[1]) };
  return null;
}

export function parseNethogsLine(line: string, delaySec: number, at: number): ParseResult {
  const trimmed = line.trim();
  if (!trimmed) return { events: [], skippedHeaders: 0, missingRemote: 0, unknown: 0 };
  if (/^(refreshing|waiting|time|tensor|eth|lo\b)/i.test(trimmed)) {
    return { events: [], skippedHeaders: 1, missingRemote: 0, unknown: 0 };
  }

  const tokens = trimmed.split(/\s+/);
  const sentRate = Number(tokens[0]);
  const recvRate = Number(tokens[1]);
  if (tokens[0] === undefined || tokens[1] === undefined || !RATE_RE.test(tokens[0]) || !RATE_RE.test(tokens[1])) {
    return { events: [], skippedHeaders: 1, missingRemote: 0, unknown: 0 };
  }

  const sentBytes = Math.round(sentRate * 1024 * delaySec);
  const recvBytes = Math.round(recvRate * 1024 * delaySec);
  const rest = tokens.slice(2);

  let remote: Remote | null = null;
  let pid: number | null = null;
  const nameParts: string[] = [];
  for (const tok of rest) {
    const r = matchRemote(tok);
    if (r) {
      remote = r;
      continue;
    }
    if (pid === null && /^\d+$/.test(tok)) {
      pid = Number(tok);
      continue;
    }
    nameParts.push(tok);
  }

  if (!remote) {
    return { events: [], skippedHeaders: 0, missingRemote: 1, unknown: 0 };
  }

  const name = nameParts.join(" ");
  const unattributed = pid === null || name === "" || UNKNOWN_NAME_RE.test(name);
  if (unattributed) {
    return {
      events: [{ kind: "unknown-flow", remoteIp: remote.ip, remotePort: remote.port, sentBytes, recvBytes, at }],
      skippedHeaders: 0,
      missingRemote: 0,
      unknown: 1,
    };
  }
  return {
    events: [{ kind: "flow", pid, process: name, remoteIp: remote.ip, remotePort: remote.port, sentBytes, recvBytes, at }],
    skippedHeaders: 0,
    missingRemote: 0,
    unknown: 0,
  };
}
