#!/usr/bin/env node
/**
 * netwatch-collector CLI(Phase 1):实时打印"谁在传",信息密度对齐 design.md §5.1 实时视图。
 * 用法:tsx src/cli.ts [--mock] [--delay=2] [--no-clear]
 *   --mock       mock 数据源(无需 root,开发/演示)
 *   --delay=N    nethogs 采样间隔秒数(默认 2)
 *   --no-clear   不清屏,追加式输出(便于重定向观察)
 */
import type { TrafficSource } from "@netwatch/shared";
import { createTrafficSource, NethogsSourceError } from "./sources/index.js";
import { RollingAggregator } from "./aggregate.js";
import { renderSnapshot } from "./render.js";
import { Store, defaultDbPath } from "./store.js";

const argv = process.argv.slice(2);
const mock = argv.includes("--mock");
const clearScreen = !argv.includes("--no-clear");
const delayArg = argv.find((a) => a.startsWith("--delay="));
const delaySec = delayArg ? Number(delayArg.slice("--delay=".length)) || 2 : 2;
const noDb = argv.includes("--no-db");
const dbArg = argv.find((a) => a.startsWith("--db="));

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const agg = new RollingAggregator();

// 落库(Phase 2):mock 默认内存库(演示不污染真实数据);真实源默认 XDG 数据目录
const dbPath = dbArg?.slice(5) ?? (mock ? ":memory:" : defaultDbPath());
let store: Store | null = null;
if (!noDb) {
  try {
    store = new Store(dbPath);
  } catch (err) {
    console.error(`⚠ 数据库打开失败(${dbPath}):${err instanceof Error ? err.message : String(err)};本次运行不落库`);
  }
}
let storeErrorLogged = false;
let source: TrafficSource;
try {
  source = createTrafficSource({ mock });
} catch (err) {
  fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
}

let stopped = false;
const timer = setInterval(() => {
  if (stopped) return;
  // 先落盘(整分钟桶排空),再渲染实时快照
  if (store !== null) {
    try {
      const { minutes, newDestinations } = agg.drainClosedMinutes(Date.now());
      for (const m of minutes) store.flushMinute(m.minute, m.rows);
      if (newDestinations.length > 0) store.recordDestinations(newDestinations);
    } catch (err) {
      if (!storeErrorLogged) {
        storeErrorLogged = true;
        console.error(`⚠ 落库失败(后续不再提示):${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (clearScreen) process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(renderSnapshot(agg.snapshot(), { mock }));
}, 1_000);

void (async () => {
  try {
    for await (const ev of source.events()) {
      agg.push(ev);
    }
  } catch (err) {
    stopped = true;
    clearInterval(timer);
    if (err instanceof NethogsSourceError) {
      console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
      console.error("  提示:采集端需要 root(sudo npm run collector);无 root 环境可用 --mock 体验。");
    } else {
      console.error(`\n✗ 事件流异常终止:${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
})();

function shutdown(): void {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  try {
    store?.close();
  } catch {
    // 关闭失败不影响退出
  }
  void source.stop().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.error(`netwatch collector 启动中(源:${mock ? "mock" : `nethogs ${delaySec}s`} · 库:${noDb ? "关闭" : dbPath} · Ctrl+C 退出)…`);
