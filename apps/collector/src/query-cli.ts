#!/usr/bin/env node
/**
 * netwatch-query(Phase 2):读库查询 CLI,普通用户即可运行。
 * 用法:tsx src/query-cli.ts top <10m|1h|24h|7d> [--by=process|destination] [--db=path] [--limit=20]
 */
import { topProcesses, topDestinations } from "./query.js";
import { defaultDbPath } from "./store.js";
import { fmtBytes, fmtClock } from "./render.js";
import { isLan, isLoopback } from "./aggregate.js";

const argv = process.argv.slice(2);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (argv[0] !== "top") {
  fail("用法:netwatch-query top <10m|1h|24h|7d> [--by=process|destination] [--db=path] [--limit=20]");
}
const rangeArg = argv[1] ?? fail("缺少时间范围:top <10m|1h|24h|7d>");
const m = /^(\d+)(m|h|d)$/.exec(rangeArg) ?? fail(`无法解析时间范围 "${rangeArg}";支持 10m / 1h / 24h / 7d 这类形式`);
const rangeSec = Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "d" ? 86400 : 60);

const by = argv.find((a) => a.startsWith("--by="))?.slice(5) ?? "process";
if (by !== "process" && by !== "destination") fail("--by 只支持 process|destination");
const dbPath = argv.find((a) => a.startsWith("--db="))?.slice(5) ?? defaultDbPath();
const limit = Number(argv.find((a) => a.startsWith("--limit="))?.slice(8)) || 20;

const now = Date.now();
const since = now - rangeSec * 1000;

if (by === "process") {
  const rows = topProcesses({ dbPath, rangeSec, limit });
  console.log(`netwatch query · 按进程 · 最近 ${rangeArg}(${fmtClock(since)} ~ ${fmtClock(now)}) · 库:${dbPath}`);
  if (rows.length === 0) {
    console.log("(区间内无落库数据:采集端需运行并跨过整分钟才会落盘)");
    process.exit(0);
  }
  console.log(`${"#".padEnd(4)}${"进程".padEnd(22)}${"上传".padStart(12)}${"下载".padStart(12)}${"峰值/分钟".padStart(14)}`);
  for (const [i, r] of rows.entries()) {
    const name = r.kind === "unknown-flow" ? "(归因失败)" : `${r.process}${r.pid > 0 ? `(${r.pid})` : ""}`;
    console.log(
      `${String(i + 1).padEnd(4)}${name.padEnd(22).slice(0, 22)}${fmtBytes(r.totalSent).padStart(12)}${fmtBytes(r.totalRecv).padStart(12)}${fmtBytes(r.peakMinuteSent).padStart(14)}`,
    );
  }
} else {
  const rows = topDestinations({ dbPath, rangeSec, limit });
  console.log(`netwatch query · 按目的地 · 最近 ${rangeArg}(${fmtClock(since)} ~ ${fmtClock(now)}) · 库:${dbPath}`);
  if (rows.length === 0) {
    console.log("(区间内无落库数据:采集端需运行并跨过整分钟才会落盘)");
    process.exit(0);
  }
  console.log(`${"#".padEnd(4)}${"目的地".padEnd(24)}${"归属".padEnd(20)}${"上传".padStart(12)}${"下载".padStart(12)}${"首见".padStart(12)}`);
  for (const [i, r] of rows.entries()) {
    const badge = isLoopback(r.remoteIp) ? " [代理]" : isLan(r.remoteIp) ? " [局域网]" : "";
    const dest = `${r.remoteIp}${badge}`;
    const belong = [r.domain, r.country].filter((v): v is string => v != null && v !== "").join(" · ") || "—";
    const firstSeen = r.firstSeen != null ? fmtClock(r.firstSeen) : "—";
    console.log(
      `${String(i + 1).padEnd(4)}${dest.padEnd(24).slice(0, 24)}${belong.padEnd(20).slice(0, 20)}${fmtBytes(r.totalSent).padStart(12)}${fmtBytes(r.totalRecv).padStart(12)}${firstSeen.padStart(12)}`,
    );
  }
}
