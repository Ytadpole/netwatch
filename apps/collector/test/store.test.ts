/** Store 测试:domain 富化列、destinations 回填语义、90 天清理(文件库,跨连接读取验证) */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type MinuteRow } from "../src/store.js";
import { topDestinations } from "@netwatch/shared";

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
  const dir = await mkdtemp(path.join(tmpdir(), "netwatch-store-"));
  const dbPath = path.join(dir, "test.db");
  const store = new Store(dbPath);
  return { store, dbPath, cleanup: async () => store.close() };
}

test("flushMinute 写 domain;查询侧(独立连接)能读到富化列", async () => {
  const { store, dbPath, cleanup } = await fileStore();
  store.flushMinute(M0, [row({ domain: "example.com" }), row({ remoteIp: "1.1.1.1", process: "b" })]);
  const dests = topDestinations({ dbPath, rangeSec: 3_600, now: M0 + 120_000 });
  assert.equal(dests.find((d) => d.remoteIp === "93.184.216.34")?.domain, "example.com");
  assert.equal(dests.find((d) => d.remoteIp === "1.1.1.1")?.domain, undefined);
  await cleanup();
});

test("destinations:保留最早 first_seen;domain 为空才回填;查询侧经 LEFT JOIN 可见", async () => {
  const { store, dbPath, cleanup } = await fileStore();
  store.recordDestinations([{ remoteIp: "1.2.3.4", firstSeen: 100 }]);
  store.recordDestinations([{ remoteIp: "1.2.3.4", firstSeen: 999, domain: "late.example" }]); // 不动 first_seen,回填 domain
  store.recordDestinations([{ remoteIp: "1.2.3.4", firstSeen: 888, domain: "other.example" }]); // 已有 domain 不覆盖

  store.flushMinute(M0, [row({ remoteIp: "1.2.3.4" })]);
  const d = topDestinations({ dbPath, rangeSec: 3_600, now: M0 + 120_000 }).find((r) => r.remoteIp === "1.2.3.4");
  assert.equal(d?.firstSeen, 100);
  assert.equal(d?.domain, "late.example");
  await cleanup();
});

test("pruneOlderThan:只删 cutoff 之前的明细行,destinations 不受影响", async () => {
  const { store, cleanup } = await fileStore();
  const now = M0 + 120_000;
  store.flushMinute(M0 - 91 * 86_400_000, [row({ remoteIp: "1.1.1.1" })]); // 91 天前
  store.flushMinute(M0, [row({ remoteIp: "2.2.2.2" })]); // 当下
  assert.equal(store.pruneOlderThan(90, now), 1);

  store.recordDestinations([{ remoteIp: "1.1.1.1", firstSeen: M0 }]);
  assert.equal(store.destinationFirstSeen("1.1.1.1"), M0); // 维表不清理
  await cleanup();
});
