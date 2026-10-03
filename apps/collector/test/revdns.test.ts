/** 反向 DNS 兜底测试:注入 resolver,不依赖真实网络 */
import test from "node:test";
import assert from "node:assert/strict";
import { ReverseDns } from "../src/revdns.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

test("成功解析 → domainOf 命中;失败 → 负缓存不重试;TTL 过期后重新排队", async () => {
  let calls = 0;
  const dns = new ReverseDns({
    ttlMs: 50,
    resolve: async (ip: string) => {
      calls++;
      if (ip === "8.8.8.8") return ["dns.google"];
      throw new Error("no ptr");
    },
  });

  dns.observe("8.8.8.8");
  dns.observe("9.9.9.9");
  await tick();
  assert.equal(dns.domainOf("8.8.8.8"), "dns.google");
  assert.equal(dns.domainOf("9.9.9.9"), undefined); // 负缓存
  assert.equal(calls, 2);

  // TTL 内:observe 不再触发解析
  dns.observe("8.8.8.8");
  await tick();
  assert.equal(calls, 2);

  // TTL 过期:重新解析(负缓存的 9.9.9.9 也重试一次)
  await new Promise((r) => setTimeout(r, 60));
  dns.observe("8.8.8.8");
  dns.observe("9.9.9.9");
  await tick();
  assert.equal(calls, 4);
  assert.equal(dns.domainOf("8.8.8.8"), "dns.google");
});

test("并发上限:10 个 IP 一次 pump 只在途 maxInFlight 个", async () => {
  let inFlightPeak = 0;
  let inFlight = 0;
  const dns = new ReverseDns({
    maxInFlight: 3,
    timeoutMs: 50,
    resolve: async (ip: string) => {
      inFlight++;
      inFlightPeak = Math.max(inFlightPeak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return [`host-${ip}`];
    },
  });
  for (let i = 1; i <= 10; i++) dns.observe(`10.0.0.${i}`);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(inFlightPeak, 3);
  assert.equal(dns.domainOf("10.0.0.10"), "host-10.0.0.10");
});

test("解析超时按负缓存处理", async () => {
  const dns = new ReverseDns({
    timeoutMs: 20,
    ttlMs: 10_000,
    resolve: () => new Promise((r) => setTimeout(r, 5_000)),
  });
  dns.observe("1.2.3.4");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(dns.domainOf("1.2.3.4"), undefined);
  assert.equal(dns.stats().pending, 0);
});
