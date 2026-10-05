#!/usr/bin/env node
/**
 * netwatch-collector CLI(Phase 1~3):实时打印"谁在传" + 落库 + 规则告警(§5.1/§6)。
 * 用法:tsx src/cli.ts [--mock] [--delay=2] [--no-clear] [--no-db] [--db=path] [--rules=path] [--no-rules]
 *   --mock       mock 数据源(无需 root,开发/演示;默认内存库)
 *   --delay=N    规则引擎采样窗口秒数(默认 2;采样源各自的轮询间隔不受此参数影响)
 *   --no-clear   不清屏,追加式输出(便于重定向观察)
 *   --db=path    落库路径(真实源默认 XDG 数据目录 ~/.local/share/netwatch/netwatch.db)
 *   --rules=path 规则配置 JSON(缺省用 §6 内置默认阈值)
 *   --no-db / --no-rules  分别关闭落库 / 规则引擎
 */
import type { TrafficSource } from "@netwatch/shared";
import { defaultRulesPath } from "@netwatch/shared";
import { existsSync } from "node:fs";
import { createTrafficSource, NethogsSourceError, SsSourceError } from "./sources/index.js";
import { RollingAggregator, isLoopback } from "./aggregate.js";
import { renderSnapshot, YELLOW, RESET } from "./render.js";
import { Enricher } from "./enrich.js";
import { ReverseDns } from "./revdns.js";
import { Store, defaultDbPath } from "./store.js";
import { loadRulesConfig } from "./rules/config.js";
import { RuleEngine } from "./rules/engine.js";
import { desktopNotifier, webhookNotifier } from "./rules/notify.js";

const argv = process.argv.slice(2);
const mock = argv.includes("--mock");
const clearScreen = !argv.includes("--no-clear");
const delayArg = argv.find((a) => a.startsWith("--delay="));
const delaySec = delayArg ? Number(delayArg.slice("--delay=".length)) || 2 : 2;
const noDb = argv.includes("--no-db");
const dbArg = argv.find((a) => a.startsWith("--db="));
const rulesArg = argv.find((a) => a.startsWith("--rules="));
const noRules = argv.includes("--no-rules");

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
let lastPruneAt = 0;

// 规则引擎(Phase 3):依赖落库的 destinations 表做首见判定,故跟随 store 存在与否
// 配置来源:--rules=path > 默认路径文件(~/.config/netwatch/rules.json,存在即加载)> 内置默认;SIGHUP 热重载
let engine: RuleEngine | null = null;
let rulesPath: string | undefined = rulesArg?.slice(8);
if (rulesPath === undefined && existsSync(defaultRulesPath())) rulesPath = defaultRulesPath();
if (!noRules && store !== null) {
  try {
    const rulesConfig = loadRulesConfig(rulesPath);
    const notifiers = [
      rulesConfig.notify.desktop ? desktopNotifier() : null,
      rulesConfig.notify.webhookUrl !== undefined ? webhookNotifier(rulesConfig.notify.webhookUrl) : null,
    ].filter((n): n is NonNullable<typeof n> => n !== null);
    engine = new RuleEngine(store, rulesConfig, notifiers, { intervalSec: delaySec });
  } catch (err) {
    console.error(`⚠ 规则引擎未启用:${err instanceof Error ? err.message : String(err)}`);
  }
}
process.on("SIGHUP", () => {
  if (engine === null) return;
  try {
    engine.updateConfig(loadRulesConfig(rulesPath));
    console.error("↻ 规则配置已重载(SIGHUP)");
  } catch (err) {
    console.error(`⚠ 规则配置重载失败:${err instanceof Error ? err.message : String(err)}`);
  }
});

let source: TrafficSource;
try {
  source = createTrafficSource({ mock });
} catch (err) {
  fail(`✗ ${err instanceof Error ? err.message : String(err)}`);
}

// 富化器(§3.3.1):代理 transit 识别 + 两跳关联,附加推断字段不改归因事实
const enricher = new Enricher();
// 反向 DNS 兜底(§3.3 优先级 3):活跃公网远端 → 域名,落库时打在行上
const revdns = new ReverseDns();

let stopped = false;
const timer = setInterval(() => {
  if (stopped) return;
  // 先落盘(整分钟桶排空),再渲染实时快照
  if (store !== null) {
    try {
      const { minutes, newDestinations } = agg.drainClosedMinutes(Date.now());
      const withDomain = <T extends { remoteIp: string }>(r: T): T & { domain?: string } => {
        const d = revdns.domainOf(r.remoteIp);
        return d === undefined ? r : { ...r, domain: d };
      };
      for (const m of minutes) {
        store.flushMinute(m.minute, m.rows.map(withDomain));
      }
      if (newDestinations.length > 0) {
        store.recordDestinations(newDestinations.map(withDomain));
      }
      // 90 天清理(§9):每小时最多跑一次
      const now = Date.now();
      if (now - lastPruneAt > 3_600_000) {
        lastPruneAt = now;
        const n = store.pruneOlderThan(90, now);
        if (n > 0) console.error(`🧹 已清理 90 天前的 flow_minutes 明细:${n} 行`);
      }
    } catch (err) {
      if (!storeErrorLogged) {
        storeErrorLogged = true;
        console.error(`⚠ 落库失败(后续不再提示):${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (clearScreen) process.stdout.write("\x1b[2J\x1b[H");
  const snap = agg.snapshot();
  // §5 进程间通道:实时快照高频覆盖写库,展示端只读轮询(SSE 推浏览器)
  store?.writeLiveSnapshot({ ...snap, capabilities: source.capabilities }, snap.at);
  process.stdout.write(renderSnapshot(snap, { mock }));
}, 1_000);

void (async () => {
  try {
    for await (const ev of source.events()) {
      const enriched = enricher.process(ev);
      if (enriched.kind === "flow" && !isLoopback(enriched.remoteIp)) revdns.observe(enriched.remoteIp);
      agg.push(enriched);
      if (engine !== null) {
        for (const a of engine.process(enriched)) {
          console.error(`${YELLOW}🔔 [${a.severity}] ${a.rule}${RESET} ${a.detail.message}${RESET}`);
        }
      }
    }
  } catch (err) {
    stopped = true;
    clearInterval(timer);
    if (err instanceof NethogsSourceError || err instanceof SsSourceError) {
      console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
      console.error("  提示:ss 源非 root 也可运行(他人进程归为 unknown-flow);sudo 运行可见全量。");
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

console.error(`netwatch collector 启动中(源:${mock ? "mock" : `ss 轮询 ${delaySec}s`} · 库:${noDb ? "关闭" : dbPath} · 规则:${engine !== null ? "开" : "关"} · Ctrl+C 退出)…`);
