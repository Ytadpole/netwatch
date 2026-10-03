/** 富化器测试(§3.3.1):transit 识别、两跳关联、代理进程的 new-destination 豁免 */
import test from "node:test";
import assert from "node:assert/strict";
import { Enricher } from "../src/enrich.js";
import { Store } from "../src/store.js";
import { loadRulesConfig } from "../src/rules/config.js";
import { RuleEngine } from "../src/rules/engine.js";
import type { TrafficEvent } from "@netwatch/shared";

const T0 = 1_700_000_000_000;
const PROXY_PORT = 7897;

function flow(at: number, sentBytes: number, remoteIp: string, process: string, port = 443, pid = 1): TrafficEvent {
  return { kind: "flow", pid, process, remoteIp: remoteIp, remotePort: port, sentBytes, recvBytes: 0, at };
}

test("环回跳标 viaLocalProxy;公网后到 → 代理侧得 transit;多对命中后进程被确认为 transit", () => {
  const en = new Enricher();
  // 一对:环回先到(无关联对象),公网后到(命中环回跳)
  const hop1 = en.process(flow(T0, 100_000, "127.0.0.1", "chrome", PROXY_PORT, 10));
  assert.equal(hop1.viaLocalProxy, true);
  assert.equal(hop1.viaProxyTo, undefined);

  const out1 = en.process(flow(T0 + 1_000, 98_000, "104.20.23.154", "mihomo", 443, 99));
  assert.equal(out1.transit, true);
  assert.equal(en.stats().associations, 1);

  // 再两对(字节数相近、时窗内)→ mihomo 累计 3 票确认
  en.process(flow(T0 + 3_000, 200_000, "127.0.0.1", "chrome", PROXY_PORT, 10));
  en.process(flow(T0 + 3_500, 195_000, "1.1.1.1", "mihomo", 443, 99));
  en.process(flow(T0 + 6_000, 50_000, "127.0.0.1", "chrome", PROXY_PORT, 10));
  en.process(flow(T0 + 6_200, 52_000, "2.2.2.2", "mihomo", 443, 99));
  assert.ok(en.stats().transitProcesses.includes("mihomo"));

  // 确认后:即使无环回跳可关联,mihomo 的公网出站也直接标 transit
  const out2 = en.process(flow(T0 + 9_000, 777_777, "3.3.3.3", "mihomo", 443, 99));
  assert.equal(out2.transit, true);

  // 普通应用(无命中)不标 transit
  const plain = en.process(flow(T0 + 9_100, 3_000, "4.4.4.4", "code", 443, 20));
  assert.equal(plain.transit, undefined);
});

test("公网先到、环回后到:应用跳得 viaProxyTo(标注落在后到的一跳)", () => {
  const en = new Enricher();
  const pub = en.process(flow(T0, 300_000, "9.9.9.9", "mihomo", 443, 99));
  assert.equal(pub.transit, undefined); // 尚无环回跳可证
  const hop = en.process(flow(T0 + 800, 296_000, "127.0.0.1", "chrome", PROXY_PORT, 10));
  assert.equal(hop.viaLocalProxy, true);
  assert.deepEqual(hop.viaProxyTo, { remoteIp: "9.9.9.9", remotePort: 443 });
});

test("同进程的环回跳与公网直连不互相关联;字节数超容差不匹配", () => {
  const en = new Enricher();
  // chrome 同进程:环回 100k,公网 98k —— 不允许配对
  en.process(flow(T0, 100_000, "127.0.0.1", "chrome", PROXY_PORT, 10));
  const self = en.process(flow(T0 + 500, 98_000, "8.8.8.8", "chrome", 443, 10));
  assert.equal(self.transit, undefined);
  assert.equal(en.stats().associations, 0);

  // 字节差超 ±25% 不匹配
  en.process(flow(T0 + 2_000, 100_000, "127.0.0.1", "app2", PROXY_PORT, 11));
  const far = en.process(flow(T0 + 2_500, 10_000, "7.7.7.7", "mihomo", 443, 99));
  assert.equal(far.transit, undefined);
});

test("端到端:确认为 transit 的代理进程不再触发 new-destination;普通应用照常触发", () => {
  const en = new Enricher();
  const eng = new RuleEngine(new Store(":memory:"), loadRulesConfig(), [], { intervalSec: 2 });
  const feed = (e: TrafficEvent): number => eng.process(en.process(e)).length;

  // 冷启动首屏批(≤3s):三对代理两跳,全部静默;同时 mihomo 攒满 3 票
  feed(flow(T0, 100_000, "127.0.0.1", "chrome", PROXY_PORT, 10));
  feed(flow(T0 + 500, 98_000, "104.20.23.154", "mihomo", 443, 99));
  feed(flow(T0 + 1_000, 200_000, "127.0.0.1", "chrome", PROXY_PORT, 10));
  feed(flow(T0 + 1_500, 196_000, "1.1.1.1", "mihomo", 443, 99));
  feed(flow(T0 + 2_000, 50_000, "127.0.0.1", "chrome", PROXY_PORT, 10));
  feed(flow(T0 + 2_500, 51_000, "2.2.2.2", "mihomo", 443, 99));

  // 首屏批后:mihomo(已确认 transit)连新公网 IP → 不告警;chrome 直连新公网 IP → 告警
  const viaProxy = feed(flow(T0 + 5_000, 10_000, "9.9.9.9", "mihomo", 443, 99));
  assert.equal(viaProxy, 0, "transit 代理进程的新目的地不告警");
  const direct = feed(flow(T0 + 5_100, 10_000, "8.8.4.4", "chrome", 443, 10));
  assert.equal(direct, 1, "普通应用的新目的地照常告警");
});
