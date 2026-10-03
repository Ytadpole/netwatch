/** 目的地分类规则表测试(§11;shared/classify.ts) */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyDomain, CATEGORY_LABELS, DESTINATION_CATEGORIES } from "@netwatch/shared";

test("AI 服务:主域、子域、国内厂商都能命中", () => {
  assert.equal(classifyDomain("api.openai.com"), "ai");
  assert.equal(classifyDomain("openai.com"), "ai");
  assert.equal(classifyDomain("claude.ai"), "ai");
  assert.equal(classifyDomain("generativelanguage.googleapis.com"), "ai");
  assert.equal(classifyDomain("dashscope.aliyuncs.com"), "ai"); // 优先于 aliyuncs 的对象存储泛匹配
  assert.equal(classifyDomain("api.deepseek.com"), "ai");
});

test("网盘与对象存储:子域后缀命中;未知域名返回 undefined", () => {
  assert.equal(classifyDomain("drive.google.com"), "cloud-storage");
  assert.equal(classifyDomain("www.dropbox.com"), "cloud-storage");
  assert.equal(classifyDomain("mybucket.s3.amazonaws.com"), "object-storage");
  assert.equal(classifyDomain("s3.amazonaws.com"), "object-storage");
  assert.equal(classifyDomain("oss-cn-hangzhou.aliyuncs.com"), "object-storage");
  assert.equal(classifyDomain("xxx.r2.cloudflarestorage.com"), "object-storage");

  assert.equal(classifyDomain("example.com"), undefined);
  assert.equal(classifyDomain("github.com"), undefined); // 不猜
  assert.equal(classifyDomain(undefined), undefined);
  assert.equal(classifyDomain(null), undefined);
  assert.equal(classifyDomain(""), undefined);
});

test("边界:结尾点容忍、大小写不敏感、'.' 拼接防前缀误匹配", () => {
  assert.equal(classifyDomain("claude.ai."), "ai"); // 根域写法
  assert.equal(classifyDomain("API.OPENAI.COM"), "ai");
  assert.equal(classifyDomain("notopenai.com"), undefined); // 不能靠 "openai.com" 前缀误命中
  assert.equal(classifyDomain("evildropbox.com"), undefined); // 同上
});

test("分类表完整性:每个分类都有中文标签", () => {
  for (const c of DESTINATION_CATEGORIES) {
    assert.ok(CATEGORY_LABELS[c].length > 0);
  }
});
