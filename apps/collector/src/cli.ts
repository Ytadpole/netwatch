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

const argv = process.argv.slice(2);
const mock = argv.includes("--mock");
const clearScreen = !argv.includes("--no-clear");
const delayArg = argv.find((a) => a.startsWith("--delay="));
const delaySec = delayArg ? Number(delayArg.slice("--delay=".length)) || 2 : 2;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const agg = new RollingAggregator();
let source: TrafficSource;
try {
  source = createTrafficSource({ mock });
} catch (err) {
  fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
}

let stopped = false;
const timer = setInterval(() => {
  if (stopped) return;
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
  void source.stop().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.error(`netwatch collector 启动中(源:${mock ? "mock" : `nethogs ${delaySec}s`} · Ctrl+C 退出)…`);
