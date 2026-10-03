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

test("规则配置:JSON 加载、默认补全、坏文件显性报错", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "netwatch-cfg-"));
  const p = path.join(dir, "rules.json");
  await writeFile(p, JSON.stringify({ volumeThreshold: { bytesPer10min: 1 }, whitelist: [{ process: "a", remoteIp: "1.2.3.4" }] }));
  const cfg = loadRulesConfig(p);
  assert.equal(cfg.volumeThreshold.bytesPer10min, 1);
  assert.equal(cfg.newDestination.enabled, true); // 未写字段的默认补全
  assert.equal(cfg.whitelist.length, 1);

  await writeFile(p, "{ broken json");
  assert.throws(() => loadRulesConfig(p), /规则配置文件/);

  await writeFile(p, JSON.stringify({ volumeThreshold: { bytesPer10min: -5 } }));
  assert.throws(() => loadRulesConfig(p), /未过校验/);
});
