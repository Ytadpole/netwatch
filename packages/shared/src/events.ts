/**
 * 采集层输出契约(design.md §3.5),Phase 0 定稿。
 *
 * 语义约定:
 * - `sentBytes` / `recvBytes` 是**本次采样窗口内的增量字节数**,不是累计计数器,
 *   也不是速率——速率型数据源(如 nethogs 的 KB/s)由各平台实现负责换算成增量。
 * - `at` 是采样窗口的结束时刻(Unix 毫秒)。聚合器按它归入分钟桶。
 * - `flow.pid` 为 null:进程名已知但 PID 缺失(典型:连接仍在、进程已退出)。
 *   完全归因不到进程的流量(nethogs 的 UNKNOWN 行)用独立的 `unknown-flow` 事件,
 *   两者不得混用——规则引擎对 unknown-flow 单独处理(§6)。
 * - 已知盲区:本机走环回代理时(如 127.0.0.1:7897),进程事件里的 remoteIp
 *   是代理地址而非真实远端,真实远端出现在代理进程的事件里。富化层需识别环回地址。
 */

export interface FlowEvent {
  kind: "flow";
  pid: number | null;
  process: string;
  remoteIp: string;
  remotePort: number;
  sentBytes: number;
  recvBytes: number;
  at: number;
}

/** 归因不到进程的流量 */
export interface UnknownFlowEvent {
  kind: "unknown-flow";
  remoteIp: string;
  remotePort: number;
  sentBytes: number;
  recvBytes: number;
  at: number;
}

/** 解析器只允许产出这两种事件(判别联合) */
export type TrafficEvent = FlowEvent | UnknownFlowEvent;

/** 富化字段,来源:DNS 观察 / 反向 DNS / GeoLite2 本地库(§3.3),均可缺省 */
export interface Enrichment {
  domain?: string;
  country?: string;
  asn?: string;
}

/** 富化后的流事件:聚合器与规则引擎消费的形态;firstSeen 由聚合器对照 destinations 表得出 */
export type EnrichedFlow = FlowEvent & Enrichment & { firstSeen: boolean };
