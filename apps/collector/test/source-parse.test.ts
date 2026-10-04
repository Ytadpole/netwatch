/** 真实样本回放测试(Phase 0 校准):nethogs 0.8.7 行格式 + ss -tinp 块 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseNethogsText } from "../src/sources/linux/parse.js";
import { parseSsSnapshot } from "../src/sources/linux/ss.js";
import type { TrafficEvent } from "@netwatch/shared";

const T0 = 1_700_000_000_000;

test("nethogs 真实行:program/pid/uid 三列、全路径进程名、unknown 行、头部噪音", () => {
  const text = [
    "Refreshing:",
    "",
    "zcode-host-local-1/294939/1000\t0.126172\t0.0691406",
    "/usr/sbin/tailscaled/914/0\t0.0167969\t0.0291016",
    "unknown TCP/0/0\t141.44\t0",
    "Unknown connection: 127.0.0.1:8765-127.0.0.1:41306",
    "Ethernet link detected",
  ].join("\n");
  const r = parseNethogsText(text, 2, T0);
  assert.equal(r.events.length, 3);
  assert.equal(r.skippedHeaders, 4); // Refreshing:/Unknown connection:/空行/Ethernet
  assert.equal(r.unknown, 1);

  const zcode = r.events[0] as Extract<TrafficEvent, { kind: "flow" }>;
  assert.equal(zcode.process, "zcode-host-local-1");
  assert.equal(zcode.pid, 294939);
  assert.equal(zcode.sentBytes, Math.round(0.126172 * 1024 * 2));

  const tailscaled = r.events[1] as Extract<TrafficEvent, { kind: "flow" }>;
  assert.equal(tailscaled.process, "/usr/sbin/tailscaled"); // 全路径保留
  assert.equal(tailscaled.pid, 914);

  const unk = r.events[2];
  assert.equal(unk.kind, "unknown-flow");
  assert.equal(unk.sentBytes, Math.round(141.44 * 1024 * 2));
});

test("ss 两拍做差:首拍只建基线;增量按连接产出;无归属连接 → unknown-flow;消失连接停止跟踪", () => {
  const pollA = [
    "Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process",
    " 0 0  192.168.1.8:43916  36.170.26.75:443  users:((\"ZCode\",pid=294620,fd=127))",
    "\t cubic bytes_sent:11455 bytes_received:15825 segs_out:317",
    " 0 0  127.0.0.1:57412  127.0.0.1:7897  users:((\"firefox-bin\",pid=12792,fd=49))",
    "\t cubic bytes_sent:3863 bytes_received:4208",
    " 0 0  10.0.0.2:5555  93.184.216.34:443",
    "\t cubic bytes_sent:500 bytes_received:900",
  ].join("\n");
  const prev = new Map();
  assert.equal(parseSsSnapshot(pollA, prev, T0, true).length, 0); // 基线拍无事件
  assert.equal(prev.size, 3);

  const pollB = [
    "Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process",
    " 0 0  192.168.1.8:43916  36.170.26.75:443  users:((\"ZCode\",pid=294620,fd=127))",
    "\t cubic bytes_sent:12455 bytes_received:15825", // ↑1000 sent
    " 0 0  127.0.0.1:57412  127.0.0.1:7897  users:((\"firefox-bin\",pid=12792,fd=49))",
    "\t cubic bytes_sent:4363 bytes_received:4708", // ↑500/↑500
    " 0 0  10.0.0.2:5555  93.184.216.34:443", // 无 users: 归属
    "\t cubic bytes_sent:1300 bytes_received:900", // ↑800 → unknown-flow
    " 0 0  172.17.0.1:6666  2.2.2.2:443  users:((\"newconn\",pid=7,fd=1))", // 首见:只建基线
    "\t cubic bytes_sent:99999 bytes_received:1",
  ].join("\n");
  const events = parseSsSnapshot(pollB, prev, T0 + 2_000, false);
  assert.equal(events.length, 3);
  assert.equal(prev.size, 4); // 3 存量 + 1 新连接(10.0.0.2 那条没消失,只是换了归属态?——不,同键仍在)

  const z = events[0] as Extract<TrafficEvent, { kind: "flow" }>;
  assert.deepEqual([z.process, z.pid, z.remoteIp, z.remotePort, z.sentBytes, z.recvBytes], ["ZCode", 294620, "36.170.26.75", 443, 1000, 0]);
  const f = events[1] as Extract<TrafficEvent, { kind: "flow" }>;
  assert.deepEqual([f.process, f.remoteIp, f.remotePort, f.sentBytes, f.recvBytes], ["firefox-bin", "127.0.0.1", 7897, 500, 500]);
  const unk = events[2];
  assert.equal(unk.kind, "unknown-flow");
  assert.deepEqual([unk.remoteIp, unk.remotePort, unk.sentBytes], ["93.184.216.34", 443, 800]);

  // 下一拍只有一条连接 → 其余键被清除
  const pollC = [
    "Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process",
    " 0 0  192.168.1.8:43916  36.170.26.75:443  users:((\"ZCode\",pid=294620,fd=127))",
    "\t cubic bytes_sent:12455 bytes_received:15825",
  ].join("\n");
  assert.equal(parseSsSnapshot(pollC, prev, T0 + 4_000, false).length, 0); // 计数未变,无事件
  assert.equal(prev.size, 1); // 消失的连接移出跟踪表
});
