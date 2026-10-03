/** 规则引擎配置(§6):zod 校验,缺省值即设计默认阈值;--rules=path 时从 JSON 加载 */

import { readFileSync } from "node:fs";
import { z } from "zod";

const newDestinationSchema = z.object({
  enabled: z.boolean().default(true),
  /** 同进程当分钟上传超过该值时,severity 从 info 升 warn(§6:10MB/min) */
  escalateBytesPerMin: z.number().int().positive().default(10 * 1024 * 1024),
});

const volumeThresholdSchema = z.object({
  enabled: z.boolean().default(true),
  bytesPer10min: z.number().int().positive().default(100 * 1024 * 1024),
  bytesPerHour: z.number().int().positive().default(500 * 1024 * 1024),
});

const unknownProcessSchema = z.object({
  enabled: z.boolean().default(true),
  /** 连续多少个采样窗口(§6:3) */
  consecutiveWindows: z.number().int().min(2).default(3),
  bytesPerMin: z.number().int().positive().default(1024 * 1024),
});

export const RulesConfigSchema = z.object({
  newDestination: newDestinationSchema.prefault({}),
  volumeThreshold: volumeThresholdSchema.prefault({}),
  unknownProcess: unknownProcessSchema.prefault({}),
  /** process × remote_ip 级白名单,命中静默;remoteIp 可用 "*" 表示该进程对任意目的地静默 */
  whitelist: z.array(z.object({ process: z.string().min(1), remoteIp: z.string().min(1) })).default([]),
  notify: z
    .object({
      desktop: z.boolean().default(true),
      webhookUrl: z.string().optional(),
    })
    .prefault({}),
});
export type RulesConfig = z.infer<typeof RulesConfigSchema>;

/** path 为 undefined 时返回全默认配置;文件不存在/JSON 坏/校验不过都直接抛错(配置错误要显性失败) */
export function loadRulesConfig(path?: string): RulesConfig {
  if (path === undefined) return RulesConfigSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`规则配置文件读取失败(${path}):${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = RulesConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`规则配置文件未过校验(${path}):${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
