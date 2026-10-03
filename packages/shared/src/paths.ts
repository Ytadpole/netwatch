/** 进程间通道与两进程共用的路径约定(§5:SQLite 是唯一耦合点,采集端写、展示端读) */

import { homedir } from "node:os";
import path from "node:path";

export function defaultDbPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(base, "netwatch", "netwatch.db");
}

export function defaultRulesPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "netwatch", "rules.json");
}
