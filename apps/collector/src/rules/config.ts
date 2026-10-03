/** 规则引擎配置(§6):缺省即设计默认阈值;--rules=path 或默认路径文件存在时从 JSON 加载(SIGHUP 热重载) */

import { mergeRulesFile, type RulesFile } from "@netwatch/shared";
import { readFileSync } from "node:fs";

export type RulesConfig = RulesFile;

/** path 为 undefined 时返回全默认配置;文件不存在/JSON 坏/校验不过都直接抛错(配置错误要显性失败) */
export function loadRulesConfig(path?: string): RulesConfig {
  if (path === undefined) return mergeRulesFile({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`规则配置文件读取失败(${path}):${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return mergeRulesFile(raw);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}(${path})`);
  }
}
