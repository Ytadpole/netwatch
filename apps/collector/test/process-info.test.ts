/** 进程画像(§11):/proc 抽取(exe 路径、启动时刻)、缓存、可疑路径判定 —— procRoot 可注入,用伪造目录树测试 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { ProcessInspector, isSuspiciousPath } from "../src/process-info.js";

test("ProcessInspector:抽取 exe 与启动时刻;缓存命中;缺失 pid 返回 null", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "netwatch-proc-"));
  mkdirSync(path.join(root, "123"), { recursive: true });
  symlinkSync("/tmp/evil-agent", path.join(root, "123", "exe"));
  // 字段 22 starttime = 100 tick;comm 字段含括号,解析须取最后一个 ')' 之后(字段 4~21 共 18 个 0)
  const stat = `123 (evil) S ${"0 ".repeat(18)}100 0 0 0\n`;
  writeFileSync(path.join(root, "123", "stat"), stat);
  writeFileSync(path.join(root, "stat"), "cpu  1 2 3 4\nbtime 1700000000\n");

  const insp = new ProcessInspector(root);
  const info = insp.inspect(123);
  assert.ok(info !== null);
  assert.equal(info!.exePath, "/tmp/evil-agent");
  assert.equal(info!.startedAt, 1_700_000_000_000 + 1_000); // btime×1000 + 100 tick / 100Hz
  assert.equal(isSuspiciousPath(info!.exePath), true);
  assert.equal(insp.inspect(123), info); // 缓存命中(同一对象)

  assert.equal(insp.inspect(999), null); // 不存在的 pid
  assert.equal(isSuspiciousPath("/usr/bin/nextcloud-sync"), false);
  assert.equal(isSuspiciousPath("/usr/bin/evil (deleted)"), true); // 落地即删
  assert.equal(isSuspiciousPath("/dev/shm/x"), true);
});
