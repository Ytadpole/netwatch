/** 规则配置文件读写(Web 端;白名单 CRUD 写回后采集端 SIGHUP 或重启生效) */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_RULES, mergeRulesFile, type RulesFile } from "@netwatch/shared";

export function readRulesFile(rulesPath: string): RulesFile {
  if (!existsSync(rulesPath)) return DEFAULT_RULES;
  return mergeRulesFile(JSON.parse(readFileSync(rulesPath, "utf8"))); // 坏配置直接抛,路由层 500 显性暴露
}

export function updateWhitelist(
  rulesPath: string,
  action: "add" | "remove",
  entry: { process: string; remoteIp: string },
): RulesFile {
  const current = existsSync(rulesPath) ? readRulesFile(rulesPath) : DEFAULT_RULES;
  const whitelist = current.whitelist.filter((w) => !(w.process === entry.process && w.remoteIp === entry.remoteIp));
  if (action === "add") whitelist.push(entry);
  const next = mergeRulesFile({ ...current, whitelist });
  mkdirSync(path.dirname(rulesPath), { recursive: true });
  writeFileSync(rulesPath, JSON.stringify(next, null, 2) + "\n");
  return next;
}
