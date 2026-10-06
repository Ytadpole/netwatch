/** RollingAggregator 直测(补覆盖缺口):速率窗、NEW 首见/冷启动 baseline、分钟桶排空、进程画像注入 */
import test from "node:test";
import assert from "node:assert/strict";
import { RollingAggregator } from "../src/aggregate.js";
import type { TrafficEvent } from "@netwatch/shared";

const T0 = 1_700_000_000_000;
const M0 = Math.floor(T0 / 60_000) * 60_000;

function flow(at: number, sent: number, remoteIp = "93.184.216.34", process = "app", pid = 1): TrafficEvent {
  return { kind: "flow", pid, process, remoteIp, remotePort: 443, sentBytes: sent, recvBytes: 0, at };
}

test("snapshot:速率窗口聚合、占比、NEW 首见与冷启动 baseline 静默", () => {
  const agg = new RollingAggregator({ rateWindowMs: 10_000, newDestWindowMs: 5 * 60_000 });
  // 首屏批(≤3s):存量目的地不标 NEW(部署瞬间不弹满屏 NEW)
  agg.push(flow(T0, 1_000));
  agg.push(flow(T0 + 1_000, 1_000, "198.51.100.1", "b", 2));
  let snap = agg.snapshot(T0 + 2_000);
  assert.equal(snap.processes.length, 2);
  assert.ok(snap.processes.every((p) => p.destinations.every((d) => !d.isNew)));

  // 窗口之后的新目的地 → NEW;占比 = 该目的地速率 / 进程总速率
  agg.push(flow(T0 + 6_000, 3_000, "198.51.100.2", "b", 2));
  snap = agg.snapshot(T0 + 7_000);
  const b = snap.processes.find((p) => p.process === "b");
  assert.ok(b !== undefined);
  const d2 = b!.destinations.find((d) => d.remoteIp === "198.51.100.2");
  assert.ok(d2 !== undefined);
  assert.equal(d2!.isNew, true);
  assert.equal(d2!.share, 0.75); // 速率窗内 b 有两个目的地:300/(100+300)
  // 速率窗 10s 内总上传 = 1000+1000+3000 → 500 B/s
  assert.equal(Math.round(snap.totalSentRate), 500);
});

test("drainClosedMinutes:排空已关闭分钟、保留当前;newDestinations 只上报一次", () => {
  const agg = new RollingAggregator();
  agg.push(flow(M0 + 1_000, 1_000));
  agg.push(flow(M0 + 61_000, 2_000, "198.51.100.9"));

  let d = agg.drainClosedMinutes(M0 + 62_000);
  assert.equal(d.minutes.length, 1); // M0 已关闭
  assert.equal(d.minutes[0]!.minute, M0);
  assert.equal(d.minutes[0]!.rows[0]!.sent, 1_000);
  assert.equal(d.newDestinations.length, 2);
  assert.equal(agg.minuteTotals(M0 + 60_000).sent, 2_000); // 当前分钟仍在内存

  d = agg.drainClosedMinutes(M0 + 122_000);
  assert.equal(d.minutes.length, 1); // M0+1min 这时才关闭
  assert.equal(d.minutes[0]!.rows[0]!.sent, 2_000);
  assert.equal(d.newDestinations.length, 0); // 首见不重复上报
  assert.equal(agg.minuteTotals(M0 + 60_000).sent, 0); // 已排空的桶从内存移除
});

test("snapshot:processInfo 注入 → 画像字段挂上进程行;unknown 与解析失败不挂", () => {
  const agg = new RollingAggregator({
    processInfo: (pid) => (pid === 7 ? { exePath: "/tmp/x", startedAt: 123 } : null),
  });
  agg.push(flow(T0, 1_000, "203.0.113.5", "evil", 7));
  agg.push({ kind: "unknown-flow", remoteIp: "198.51.100.7", remotePort: 443, sentBytes: 500, recvBytes: 0, at: T0 + 1_000 });
  const snap = agg.snapshot(T0 + 2_000);
  const evil = snap.processes.find((p) => p.process === "evil");
  assert.ok(evil !== undefined);
  assert.equal(evil!.exePath, "/tmp/x");
  assert.equal(evil!.startedAt, 123);
  assert.equal(evil!.suspicious, true); // /tmp 下 → 可疑
  const unk = snap.processes.find((p) => p.unattributed);
  assert.ok(unk !== undefined);
  assert.equal(unk!.exePath, undefined);
});
