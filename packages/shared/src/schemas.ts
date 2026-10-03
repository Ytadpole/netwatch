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
  rule: z.enum(["new-destination", "volume-threshold", "unknown-process"]),
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
  totalSent: z.number().int().nonnegative(),
  totalRecv: z.number().int().nonnegative(),
  peakMinuteSent: z.number().int().nonnegative(),
});
export type TopDestinationRow = z.infer<typeof TopDestinationRowSchema>;
