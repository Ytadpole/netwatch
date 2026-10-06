/** 目的地画像(§11):维表/区间汇总/进程分解/每分钟序列(文件库,跨连接读取验证) */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type MinuteRow } from "../src/store.js";
import { destinationProfile } from "@netwatch/shared";

const M0 = Math.floor(1_700_000_000_000 / 60_000) * 60_000;

function row(partial: Partial<MinuteRow>): MinuteRow {
  return {
    kind: "flow",
    pid: 1,
    process: "app",
    remoteIp: "93.184.216.34",
    remotePort: 443,
    sent: 1_000,
    recv: 100,
    ...partial,
  };
}

async function fileStore(): Promise<{ store: Store; dbPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "netwatch-dest-"));
  const dbPath = path.join(dir, "test.db");
  const store = new Store(dbPath);
  return { store, dbPath, cleanup: async () => store.close() };
}

test("destinationProfile:汇总/峰值/进程分解/每分钟系列 与落库数据一致", async () => {
  const { store, dbPath, cleanup } = await fileStore();
  store.flushMinute(M0, [
    row({ process: "chrome", remoteIp: "203.0.113.7", sent: 5_000, recv: 1_000 }),
    row({ process: "backup", remoteIp: "203.0.113.7", sent: 40_000, recv: 4_000, domain: "backup.example.com" }),
  ]);
  store.flushMinute(M0 + 60_000, [
    row({ process: "chrome", remoteIp: "203.0.113.7", sent: 3_000, recv: 500 }),
    row({ process: "backup", remoteIp: "203.0.113.7", sent: 60_000, recv: 6_000 }),
  ]);
  store.recordDestinations([{ remoteIp: "203.0.113.7", firstSeen: M0 - 1_000, domain: "backup.example.com" }]);

  const p = destinationProfile({ dbPath, remoteIp: "203.0.113.7", rangeSec: 3_600, now: M0 + 120_000 });
  assert.equal(p.remoteIp, "203.0.113.7");
  assert.equal(p.domain, "backup.example.com");
  assert.equal(p.firstSeen, M0 - 1_000);
  assert.equal(p.totalSent, 108_000);
  assert.equal(p.totalRecv, 11_500);
  assert.equal(p.peakMinuteSent, 63_000);
  assert.equal(p.series.length, 2);
  assert.equal(p.series[0]!.sent, 45_000);
  assert.equal(p.series[1]!.recv, 6_500);
  assert.equal(p.processes.length, 2);
  assert.equal(p.processes[0]!.process, "backup"); // 按上传降序
  assert.equal(p.processes[0]!.totalSent, 100_000);
  assert.equal(p.processes[1]!.process, "chrome");
  assert.equal(p.processes[1]!.peakMinuteSent, 5_000);
  await cleanup();
});

test("destinationProfile:区间无流量但有维表 → 汇总为零;完全未知 → 空画像", async () => {
  const { store, dbPath, cleanup } = await fileStore();
  store.recordDestinations([{ remoteIp: "198.51.100.9", firstSeen: M0 }]);

  const empty = destinationProfile({ dbPath, remoteIp: "198.51.100.9", rangeSec: 3_600, now: M0 + 60_000 });
  assert.equal(empty.remoteIp, "198.51.100.9");
  assert.equal(empty.totalSent, 0);
  assert.equal(empty.processes.length, 0);
  assert.equal(empty.series.length, 0);

  const unknown = destinationProfile({ dbPath, remoteIp: "192.0.2.1", rangeSec: 3_600, now: M0 + 60_000 });
  assert.equal(unknown.totalSent, 0);
  assert.equal(unknown.domain, undefined);
  assert.equal(unknown.firstSeen, undefined);
  await cleanup();
});
