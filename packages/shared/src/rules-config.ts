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
    whitelist: Array.isArray(p.whitelist) ? (p.whitelist as RulesFile["whitelist"]) : DEFAULT_RULES.whitelist,
    notify: section("notify"),
  };
  const parsed = RulesFileSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`规则配置未过校验:${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
