/** 基线异常学习(§11):偏离两周日常量级 → warn;低偏离/历史不足/小流量/白名单不告警(合成数据) */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { loadRulesConfig } from "../src/rules/config.js";
import { BaselineAnalyzer } from "../src/rules/baseline.js";
import type { Alert } from "../src/rules/engine.js";
import type { MinuteRow } from "../src/store.js";

const MB = 1024 * 1024;
const M0 = Math.floor(1_700_000_000_000 / 60_000) * 60_000;
const DAY = 86_400_000;
const KEY_IP = "203.0.113.20";
const NOW = M0 + 12 * DAY + 3_600_000; // 第 13 天(今天)的一小时处

function row(sent: number): MinuteRow {
  return { kind: "flow", pid: 1, process: "evil", remoteIp: KEY_IP, remotePort: 443, sent, recv: 0 };
}

async function makeStore(
  days: Array<{ day: number; sent: number }>,
  todaySent: number,
): Promise<{ analyzer: BaselineAnalyzer; store: Store; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "netwatch-baseline-"));
  const store = new Store(path.join(dir, "test.db"));
  for (const d of days) {
    store.flushMinute(M0 + d.day * DAY + 3_600_000, [row(d.sent)]);
  }
  if (todaySent > 0) store.flushMinute(M0 + 12 * DAY + 3_600_000, [row(todaySent)]);
  const analyzer = new BaselineAnalyzer(store, loadRulesConfig(), []);
  return { analyzer, store, cleanup: async () => store.close() };
}

test("baseline:今日量级显著偏离两周日常 → warn 一次并入库;同日再跑不重复", async () => {
  const days = Array.from({ length: 12 }, (_, i) => ({ day: i, sent: 10 * MB }));
  const { analyzer, store, cleanup } = await makeStore(days, 60 * MB);
  const alerts: Alert[] = analyzer.run(NOW);
  const ba = alerts.filter((a) => a.rule === "baseline-anomaly");
  assert.equal(ba.length, 1);
  assert.equal(ba[0]!.severity, "warn");
  assert.equal(ba[0]!.detail.process, "evil");
  assert.equal(ba[0]!.detail.remoteIp, KEY_IP);
  const stored = store.recentAlerts(5).filter((a) => a.rule === "baseline-anomaly");
  assert.equal(stored.length, 1);
  // 同日再跑:每 key 每日至多一条
  assert.equal(analyzer.run(NOW + 3_600_000).filter((a) => a.rule === "baseline-anomaly").length, 0);
  await cleanup();
});

test("baseline:低偏离/历史不足/小流量/白名单 均不告警", async () => {
  // 低偏离:今日 11MB > 均值 10MB 但 ≤ 1.5×均值(相对护栏)
  {
    const days = Array.from({ length: 12 }, (_, i) => ({ day: i, sent: 10 * MB }));
    const { analyzer, cleanup } = await makeStore(days, 11 * MB);
    assert.equal(analyzer.run(NOW).filter((a) => a.rule === "baseline-anomaly").length, 0);
    await cleanup();
  }
  // 历史不足:5 个活跃日 < minHistoryDays 10
  {
    const days = Array.from({ length: 5 }, (_, i) => ({ day: i, sent: 10 * MB }));
    const { analyzer, cleanup } = await makeStore(days, 60 * MB);
    assert.equal(analyzer.run(NOW).filter((a) => a.rule === "baseline-anomaly").length, 0);
    await cleanup();
  }
  // 小流量:今日 5MB < 10MB 绝对下限
  {
    const days = Array.from({ length: 12 }, (_, i) => ({ day: i, sent: 1 * MB }));
    const { analyzer, cleanup } = await makeStore(days, 5 * MB);
    assert.equal(analyzer.run(NOW).filter((a) => a.rule === "baseline-anomaly").length, 0);
    await cleanup();
  }
  // 白名单(进程 × IP)静默
  {
    const days = Array.from({ length: 12 }, (_, i) => ({ day: i, sent: 10 * MB }));
    const { analyzer, cleanup } = await makeStore(days, 60 * MB);
    analyzer.config.whitelist.push({ process: "evil", remoteIp: KEY_IP });
    assert.equal(analyzer.run(NOW).filter((a) => a.rule === "baseline-anomaly").length, 0);
    await cleanup();
  }
});
