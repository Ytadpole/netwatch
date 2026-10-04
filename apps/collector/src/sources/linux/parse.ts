import type { TrafficEvent } from "@netwatch/shared";

/**
 * nethogs -t 行解析(0.8.7 真实格式,Phase 0 样本校准,样本 docs/samples/nethogs.txt)。
 *
 * 数据行(tab 分隔):`program/pid/uid\tsent\trecv`
 *  - sent/recv 为 KB/s 速率,按采样间隔换算成窗口内增量字节;
 *  - 进程名可含 `/`(全路径),解析从行首匹配到最后的 `/pid/uid` 组;
 *  - `unknown TCP/0/0`、`unknown UDP/0/0` 等为归因失败行 → unknown-flow(无远端,
 *    remoteIp 置空串,聚合器按 unknown 维度归卡展示;真实远端只能靠 ss 主路径);
 *  - `Unknown connection: a-b`(连接关闭瞬间)与 `Refreshing:`/`Adding local address:`
 *    等头部噪音跳过并计数。
 * 注意:trace 模式无远端地址列,本源只能给"谁在传"(§3.1 降级/交叉验证源)。
 */

export interface ParseResult {
  events: TrafficEvent[];
  skippedHeaders: number;
  /** 归因失败行(unknown TCP/UDP) */
  unknown: number;
}

const RATE_RE = /^\d+(\.\d+)?$/;
// 行尾的 /pid/uid:pid 与 uid 均为纯数字,program 可含任意字符(含 /)
const TAIL_RE = /^(.*)\/(\d+)\/(\d+)$/;
const UNKNOWN_RE = /^unknown (TCP|UDP)(\/\d+\/\d+)?$/;

export function parseNethogsLine(line: string, delaySec: number, at: number): ParseResult {
  const trimmed = line.trim();
  if (trimmed === "") return { events: [], skippedHeaders: 1, unknown: 0 }; // 空行也是噪音

  const cols = trimmed.split("\t");
  if (cols.length !== 3 || !RATE_RE.test(cols[1] ?? "") || !RATE_RE.test(cols[2] ?? "")) {
    return { events: [], skippedHeaders: 1, unknown: 0 }; // Refreshing:/头部噪音/Unknown connection: 等
  }

  const tail = TAIL_RE.exec(cols[0] ?? "");
  if (tail === null) return { events: [], skippedHeaders: 1, unknown: 0 };
  const [, programRaw, pidRaw] = tail;
  const sentBytes = Math.round(Number(cols[1]) * 1024 * delaySec);
  const recvBytes = Math.round(Number(cols[2]) * 1024 * delaySec);

  if (programRaw !== undefined && UNKNOWN_RE.test(programRaw)) {
    return {
      events: [{ kind: "unknown-flow", remoteIp: "", remotePort: 0, sentBytes, recvBytes, at }],
      skippedHeaders: 0,
      unknown: 1,
    };
  }

  const pid = Number(pidRaw);
  return {
    events: [{
      kind: "flow",
      pid: pid > 0 ? pid : null,
      process: programRaw ?? "",
      remoteIp: "",
      remotePort: 0,
      sentBytes,
      recvBytes,
      at,
    }],
    skippedHeaders: 0,
    unknown: 0,
  };
}

/** 整段 nethogs 输出 → 事件(测试/回放用) */
export function parseNethogsText(text: string, delaySec: number, at: number): ParseResult {
  const acc: ParseResult = { events: [], skippedHeaders: 0, unknown: 0 };
  const body = text.replace(/\n$/, ""); // 去掉尾部换行的空行伪影
  for (const line of body.split("\n")) {
    const r = parseNethogsLine(line, delaySec, at);
    acc.events.push(...r.events);
    acc.skippedHeaders += r.skippedHeaders;
    acc.unknown += r.unknown;
  }
  return acc;
}
