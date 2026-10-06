/** Phase 3 验收(plan.md):人为触发三条规则各一次 → 均产生告警并入库 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { loadRulesConfig } from "../src/rules/config.js";
import { RuleEngine, type Alert } from "../src/rules/engine.js";
import type { TrafficEvent } from "@netwatch/shared";

const MB = 1024 * 1024;
const T0 = 1_700_000_000_000;
const PUBLIC_IP = "93.184.216.34";

function flow(at: number, sentBytes: number, remoteIp: string = PUBLIC_IP, process = "app", pid = 1): TrafficEvent {
  return { kind: "flow", pid, process, remoteIp, remotePort: 443, sentBytes, recvBytes: 0, at };
}

test("new-destination:冷启动首屏批静默;之后公网首见告警 info;重复/白名单/局域网不告警;超量升 warn", () => {
  const store = new Store(":memory:");
  const cfg = loadRulesConfig();
  cfg.whitelist.push({ process: "ok-app", remoteIp: "8.8.8.8" });
  const eng = new RuleEngine(store, cfg, [], { intervalSec: 2 });

  // 冷启动首屏批(≤3s):存量目的地静默(部署瞬间不弹一波通知)
  assert.equal(eng.process(flow(T0, 1_000, "5.5.5.5")).length, 0);
  assert.equal(eng.process(flow(T0 + 2_000, 1_000, "6.6.6.6", "app2", 3)).length, 0);

  // 窗口之后的公网首见 → info
  const first = eng.process(flow(T0 + 4_000, 1_000));
  assert.equal(first.length, 1);
  assert.equal(first[0]!.rule, "new-destination");
  assert.equal(first[0]!.severity, "info");

  // 同 IP 重复不告
  assert.equal(eng.process(flow(T0 + 5_000, 1_000)).length, 0);
  // 白名单进程 × IP 静默
  assert.equal(eng.process(flow(T0 + 6_000, 1_000, "8.8.8.8", "ok-app", 2)).length, 0);
  // 局域网与环回不触发(§6 只盯公网)
  assert.equal(eng.process(flow(T0 + 7_000, 1_000, "192.168.1.10")).length, 0);
  assert.equal(eng.process(flow(T0 + 7_100, 1_000, "127.0.0.1")).length, 0);

  // 当分钟上传 > 10MB → severity 升 warn
  const eng2 = new RuleEngine(new Store(":memory:"), loadRulesConfig(), [], { intervalSec: 2 });
  eng2.process(flow(T0, 1_000, "9.9.9.9")); // 首屏批静默
  const escalated = eng2.process(flow(T0 + 4_000, 11 * MB, "8.8.4.4"));
  assert.equal(escalated[0]!.rule, "new-destination");
  assert.equal(escalated[0]!.severity, "warn");

  // 告警已入库
  const stored = store.recentAlerts(5).filter((a) => a.rule === "new-destination");
  assert.ok(stored.length >= 1);
  store.close();
});

test("volume-threshold:10min 超 100MB 告警一次,冷却期内不重复", () => {
  const eng = new RuleEngine(new Store(":memory:"), loadRulesConfig(), [], { intervalSec: 2 });
  const alerts: Alert[] = [];
  for (let i = 0; i < 10; i++) {
    alerts.push(...eng.process(flow(T0 + i * 10_000, 15 * MB)));
  }
  const vol = alerts.filter((a) => a.rule === "volume-threshold");
  assert.equal(vol.length, 1);
  assert.equal(vol[0]!.severity, "warn");
  // 首次越阈发生在第 7 拍(7×15MB = 105MB > 100MB)
  assert.equal(vol[0]!.detail.windowSentBytes, 105 * MB);
  assert.equal(vol[0]!.detail.windowSec, 600);

  // 冷却期内继续大上传不重复告警(volume 维度)
  const later = eng.process(flow(T0 + 120_000, 20 * MB));
  assert.equal(later.filter((a) => a.rule === "volume-threshold").length, 0);
});

test("unknown-process:连续窗口高速率外传告警;低速率不告警", () => {
  const eng = new RuleEngine(new Store(":memory:"), loadRulesConfig(), [], { intervalSec: 2 });
  const alerts: Alert[] = [];
  for (let i = 0; i < 5; i++) {
    alerts.push(...eng.process({ kind: "unknown-flow", remoteIp: "6.6.6.6", remotePort: 443, sentBytes: Math.round(1.5 * MB), recvBytes: 0, at: T0 + i * 2_000 }));
  }
  const unk = alerts.filter((a) => a.rule === "unknown-process");
  assert.ok(unk.length >= 1);
  assert.equal(unk[0]!.severity, "warn");

  // 低速率不触发:10KB/2s,短滑窗外推后 ≈0.3MB/min < 1MB/min
  const eng2 = new RuleEngine(null, loadRulesConfig(), [], { intervalSec: 2 });
  const quiet: Alert[] = [];
  for (let i = 0; i < 5; i++) {
    quiet.push(...eng2.process({ kind: "unknown-flow", remoteIp: "7.7.7.7", remotePort: 443, sentBytes: 10_000, recvBytes: 0, at: T0 + i * 2_000 }));
  }
  assert.equal(quiet.filter((a) => a.rule === "unknown-process").length, 0);
});

test("beacon:规律小包心跳告警一次并冷却;不规律/大体量/白名单不告警", () => {
  // 规律小包:每 2s 一拍 2KB,持续到跨度 ≥ 5min(默认 minSpanMs)→ 触发 info 一次
  const eng = new RuleEngine(new Store(":memory:"), loadRulesConfig(), [], { intervalSec: 2 });
  const alerts: Alert[] = [];
  for (let i = 0; i < 190; i++) {
    alerts.push(...eng.process(flow(T0 + i * 2_000, 2_000, "203.0.113.9", "telemetry", 9)));
  }
  const bc = alerts.filter((a) => a.rule === "beacon");
  assert.equal(bc.length, 1);
  assert.equal(bc[0]!.severity, "info");
  assert.equal(bc[0]!.detail.process, "telemetry");
  assert.equal(bc[0]!.detail.remoteIp, "203.0.113.9");
  // 冷却期内继续心跳不重复
  const more = eng.process(flow(T0 + 190 * 2_000, 2_000, "203.0.113.9", "telemetry", 9));
  assert.equal(more.filter((a) => a.rule === "beacon").length, 0);

  // 间隔不规律(2s/6s/11s 循环,抖动 ≈142% > 40%)不触发
  const eng2 = new RuleEngine(null, loadRulesConfig(), [], { intervalSec: 2 });
  let at = T0;
  for (let i = 0; i < 260; i++) {
    eng2.process(flow(at, 2_000, "203.0.113.10", "chatty", 9));
    at += i % 3 === 0 ? 2_000 : i % 3 === 1 ? 6_000 : 11_000;
  }
  assert.equal(alerts.filter((a) => a.rule === "beacon" && a.detail.process === "chatty").length, 0);

  // 规律但体量大(100KB/拍,正常同步的形态)不触发
  const eng3 = new RuleEngine(null, loadRulesConfig(), [], { intervalSec: 2 });
  for (let i = 0; i < 200; i++) {
    eng3.process(flow(T0 + i * 2_000, 100_000, "203.0.113.11", "sync", 9));
  }
  assert.equal(eng3.process(flow(T0 + 200 * 2_000, 100_000, "203.0.113.11", "sync", 9))
    .filter((a) => a.rule === "beacon").length, 0);

  // 白名单(进程 × IP)静默
  const eng4 = new RuleEngine(null, loadRulesConfig(), [], { intervalSec: 2 });
  eng4.config.whitelist.push({ process: "ok-heart", remoteIp: "203.0.113.12" });
  for (let i = 0; i < 200; i++) {
    eng4.process(flow(T0 + i * 2_000, 2_000, "203.0.113.12", "ok-heart", 9));
  }
  assert.equal(eng4.process(flow(T0 + 200 * 2_000, 2_000, "203.0.113.12", "ok-heart", 9))
    .filter((a) => a.rule === "beacon").length, 0);
});

test("可疑路径进程的告警升级(§11):info→warn,detail 标注路径", () => {
  const eng = new RuleEngine(new Store(":memory:"), loadRulesConfig(), [], {
    intervalSec: 2,
    processMeta: (pid) => (pid === 9 ? { exePath: "/tmp/evil-agent", suspicious: true } : null),
  });
  eng.process(flow(T0, 1_000, "5.5.5.5", "evil", 9)); // 冷启动首屏批静默
  const a = eng.process(flow(T0 + 4_000, 1_000, "6.6.6.6", "evil", 9));
  const nd = a.find((x) => x.rule === "new-destination");
  assert.ok(nd !== undefined);
  assert.equal(nd!.severity, "warn"); // info → warn
  assert.equal(nd!.detail.suspiciousPath, "/tmp/evil-agent");
  assert.ok(nd!.detail.message.includes("可疑路径"));

  // 非可疑路径进程不升级
  const eng2 = new RuleEngine(null, loadRulesConfig(), [], {
    intervalSec: 2,
    processMeta: (pid) => (pid === 9 ? { exePath: "/usr/bin/ok", suspicious: false } : null),
  });
  eng2.process(flow(T0, 1_000, "5.5.5.5", "ok", 9));
  const b = eng2.process(flow(T0 + 4_000, 1_000, "6.6.6.6", "ok", 9));
  assert.equal(b.find((x) => x.rule === "new-destination")!.severity, "info");
});

test("规则配置:JSON 加载、默认补全、坏文件显性报错", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "netwatch-cfg-"));
  const p = path.join(dir, "rules.json");
  await writeFile(p, JSON.stringify({ volumeThreshold: { bytesPer10min: 1 }, whitelist: [{ process: "a", remoteIp: "1.2.3.4" }] }));
  const cfg = loadRulesConfig(p);
  assert.equal(cfg.volumeThreshold.bytesPer10min, 1);
  assert.equal(cfg.newDestination.enabled, true); // 未写字段的默认补全
  assert.equal(cfg.beacon.enabled, true); // 第 4 条默认开启
  assert.equal(cfg.whitelist.length, 1);

  await writeFile(p, "{ broken json");
  assert.throws(() => loadRulesConfig(p), /规则配置文件/);

  await writeFile(p, JSON.stringify({ volumeThreshold: { bytesPer10min: -5 } }));
  assert.throws(() => loadRulesConfig(p), /未过校验/);
});
