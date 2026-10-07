/** 规则配置文件契约(§6):采集端加载、Web 端读改,两进程共用同一 schema 与默认值 */

import { z } from "zod";

export const RulesFileSchema = z.object({
  newDestination: z.object({
    enabled: z.boolean(),
    /** 同进程当分钟上传超过该值时,severity 从 info 升 warn(§6:10MB/min) */
    escalateBytesPerMin: z.number().int().positive(),
  }),
  volumeThreshold: z.object({
    enabled: z.boolean(),
    bytesPer10min: z.number().int().positive(),
    bytesPerHour: z.number().int().positive(),
  }),
  unknownProcess: z.object({
    enabled: z.boolean(),
    /** 连续多少个采样窗口(§6:3) */
    consecutiveWindows: z.number().int().min(2),
    bytesPerMin: z.number().int().positive(),
  }),
  beacon: z.object({
    enabled: z.boolean(),
    /** 观测窗(分钟):窗口内统计「进程 × 目的地」的上传节奏 */
    windowMin: z.number().int().min(1),
    /** 窗口内至少多少次上传采样才开始判定 */
    minSamples: z.number().int().min(4),
    /** 单次上传均值超过该值视为体量传输,不算心跳小包 */
    maxAvgBytes: z.number().int().positive(),
    /** 平均间隔上限:比这更稀疏的不算心跳 */
    maxMeanGapMs: z.number().int().positive(),
    /** 间隔抖动上限:(maxGap-minGap)/meanGap */
    gapJitter: z.number().min(0).max(1),
  /** 心跳模式需持续存在的最短跨度 */
  minSpanMs: z.number().int().positive(),
  }),
  baseline: z.object({
    enabled: z.boolean(),
    /** 学习窗(天):用过去 N-1 天(不含今天)的按日上传总量做基线 */
    historyDays: z.number().int().min(7),
    /** 至少多少个活跃日才开始判定(数据不足静默,§11:约两周起效) */
    minHistoryDays: z.number().int().min(3),
    /** 当日量超出基线均值 + N×σ 判为异常 */
    sigma: z.number().min(1),
    /** 当日上传量绝对下限:低于此值不告警(防小流量噪声) */
    floorBytes: z.number().int().positive(),
    /** 相对护栏:当日量须 > 基线均值 × 该倍数(防低方差误报) */
    minRatio: z.number().min(1),
  }),
  /** process × remote_ip 级白名单,命中静默;remoteIp 可用 "*" 表示该进程对任意目的地静默 */
  whitelist: z.array(z.object({ process: z.string().min(1), remoteIp: z.string().min(1) })),
  notify: z.object({
    desktop: z.boolean(),
    webhookUrl: z.string().optional(),
  }),
});
export type RulesFile = z.infer<typeof RulesFileSchema>;

/** §6 设计默认阈值 */
export const DEFAULT_RULES: RulesFile = {
  newDestination: { enabled: true, escalateBytesPerMin: 10 * 1024 * 1024 },
  volumeThreshold: { enabled: true, bytesPer10min: 100 * 1024 * 1024, bytesPerHour: 500 * 1024 * 1024 },
  unknownProcess: { enabled: true, consecutiveWindows: 3, bytesPerMin: 1024 * 1024 },
  beacon: { enabled: true, windowMin: 10, minSamples: 8, maxAvgBytes: 16_000, maxMeanGapMs: 90_000, gapJitter: 0.4, minSpanMs: 300_000 },
  baseline: { enabled: true, historyDays: 14, minHistoryDays: 10, sigma: 3, floorBytes: 10 * 1024 * 1024, minRatio: 1.5 },
  whitelist: [],
  notify: { desktop: true },
};

/** 部分配置文件 → 完整配置:每个分节与白名单/通知按字段与默认值合并 */
export function mergeRulesFile(partial: unknown): RulesFile {
  const p = (partial ?? {}) as Record<string, unknown>;
  const section = <K extends keyof RulesFile>(key: K): RulesFile[K] => {
    const raw = (p[key] ?? {}) as Partial<RulesFile[K]>;
    return { ...DEFAULT_RULES[key], ...raw } as RulesFile[K];
  };
  const merged: RulesFile = {
    newDestination: section("newDestination"),
    volumeThreshold: section("volumeThreshold"),
    unknownProcess: section("unknownProcess"),
  beacon: section("beacon"),
  baseline: section("baseline"),
    whitelist: Array.isArray(p.whitelist) ? (p.whitelist as RulesFile["whitelist"]) : DEFAULT_RULES.whitelist,
    notify: section("notify"),
  };
  const parsed = RulesFileSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`规则配置未过校验:${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
