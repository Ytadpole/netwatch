/** 读库模型(Phase 2):查询结果出库即过 zod 校验;Phase 4 API 层复用 */

import { z } from "zod";

/** flow_minutes 行(查询聚合后的形态,非原始行) */
export const FlowMinuteRowSchema = z.object({
  minute: z.number().int().nonnegative(),
  kind: z.enum(["flow", "unknown-flow"]),
  pid: z.number().int(),
  process: z.string(),
  remoteIp: z.string(),
  remotePort: z.number().int().min(0).max(65535),
  domain: z.string().optional(),
  country: z.string().optional(),
  asn: z.string().optional(),
  sent: z.number().int().nonnegative(),
  recv: z.number().int().nonnegative(),
});
export type FlowMinuteRow = z.infer<typeof FlowMinuteRowSchema>;

/** destinations 行 */
export const DestinationRowSchema = z.object({
  remoteIp: z.string(),
  domain: z.string().optional(),
  country: z.string().optional(),
  asn: z.string().optional(),
  /** 事件时刻(Unix 毫秒) */
  firstSeen: z.number().int().nonnegative(),
});
export type DestinationRow = z.infer<typeof DestinationRowSchema>;

/** 告警行(Phase 3 写入,此处先定读取契约) */
export const AlertRowSchema = z.object({
  id: z.number().int(),
  at: z.number().int(),
  /** 读侧容错:规则名是开放集合(事件规则 + 学习型分析器),未知名照常显示而非 500 */
  rule: z.string(),
  severity: z.enum(["info", "warn", "high"]),
  detail: z.unknown(),
});
export type AlertRow = z.infer<typeof AlertRowSchema>;

/** Top 查询·按进程(flow_minutes 聚合结果) */
export const TopProcessRowSchema = z.object({
  kind: z.enum(["flow", "unknown-flow"]),
  pid: z.number().int(),
  process: z.string(),
  totalSent: z.number().int().nonnegative(),
  totalRecv: z.number().int().nonnegative(),
  /** 区间内单分钟上传峰值(速率画像用) */
  peakMinuteSent: z.number().int().nonnegative(),
});
export type TopProcessRow = z.infer<typeof TopProcessRowSchema>;

/** Top 查询·按目的地(LEFT JOIN destinations,富化列可缺) */
export const TopDestinationRowSchema = z.object({
  remoteIp: z.string(),
  domain: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  asn: z.string().nullable().optional(),
  firstSeen: z.number().int().nonnegative().nullable().optional(),
  /** 静态规则表分类(§11;由 domain 查询时计算,未知不输出) */
  category: z.enum(["ai", "cloud-storage", "object-storage"]).optional(),
  totalSent: z.number().int().nonnegative(),
  totalRecv: z.number().int().nonnegative(),
  peakMinuteSent: z.number().int().nonnegative(),
});
export type TopDestinationRow = z.infer<typeof TopDestinationRowSchema>;

/** 目的地画像(§11):维表信息 + 区间汇总 + 进程分解 + 每分钟序列 */
export const DestProfileProcessSchema = z.object({
  kind: z.enum(["flow", "unknown-flow"]),
  pid: z.number().int(),
  process: z.string(),
  totalSent: z.number().int().nonnegative(),
  totalRecv: z.number().int().nonnegative(),
  peakMinuteSent: z.number().int().nonnegative(),
});
export type DestProfileProcess = z.infer<typeof DestProfileProcessSchema>;

export const DestinationProfileSchema = z.object({
  remoteIp: z.string(),
  domain: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  asn: z.string().nullable().optional(),
  firstSeen: z.number().int().nonnegative().nullable().optional(),
  /** 静态规则表分类(§11;由 domain 查询时计算,未知不输出) */
  category: z.enum(["ai", "cloud-storage", "object-storage"]).optional(),
  totalSent: z.number().int().nonnegative(),
  totalRecv: z.number().int().nonnegative(),
  peakMinuteSent: z.number().int().nonnegative(),
  /** 区间内碰过该目的地的进程(含归因失败组) */
  processes: z.array(DestProfileProcessSchema),
  /** 每分钟上传/下载序列(画像页面积图) */
  series: z.array(
    z.object({
      minute: z.number().int(),
      sent: z.number().int().nonnegative(),
      recv: z.number().int().nonnegative(),
    }),
  ),
});
export type DestinationProfile = z.infer<typeof DestinationProfileSchema>;

/** 实时快照(§5 进程间通道):采集端写 live_snapshot 行,Web 端读出经 SSE 推浏览器 */
export const LiveDestSchema = z.object({
  remoteIp: z.string(),
  remotePort: z.number().int(),
  sentRate: z.number(),
  recvRate: z.number(),
  share: z.number(),
  lan: z.boolean(),
  loopback: z.boolean(),
  isNew: z.boolean(),
});
export type LiveDest = z.infer<typeof LiveDestSchema>;

export const LiveProcessSchema = z.object({
  process: z.string(),
  pid: z.number().int().nullable(),
  unattributed: z.boolean(),
  sentRate: z.number(),
  recvRate: z.number(),
  destinations: z.array(LiveDestSchema),
  /** 进程画像(§11,可选:真实源读 /proc,mock 为演示伪造;pid 无法解析时不输出) */
  exePath: z.string().optional(),
  startedAt: z.number().int().optional(),
  /** exe 落在临时/运行时目录或二进制已删除(告警升级依据) */
  suspicious: z.boolean().optional(),
});
export type LiveProcess = z.infer<typeof LiveProcessSchema>;

export const LivePayloadSchema = z.object({
  at: z.number().int(),
  totalSentRate: z.number(),
  totalRecvRate: z.number(),
  processes: z.array(LiveProcessSchema),
  capabilities: z.object({ perProcessBytes: z.boolean(), dnsObservation: z.boolean() }),
});
export type LivePayload = z.infer<typeof LivePayloadSchema>;
