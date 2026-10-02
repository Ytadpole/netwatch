import type { TrafficSource } from "@netwatch/shared";
import { MockSource } from "./mock.js";
import { NethogsSource, NethogsSourceError } from "./linux/nethogs.js";

export { NethogsSourceError } from "./linux/nethogs.js";

export interface CreateSourceOptions {
  /** 开发/演示用 mock 源(无需 root) */
  mock?: boolean;
}

/** 平台分发入口(§3.4):上层只认 TrafficSource,平台差异全部封在各实现内 */
export function createTrafficSource(opts: CreateSourceOptions = {}): TrafficSource {
  if (opts.mock) return new MockSource();
  switch (process.platform) {
    case "linux":
      return new NethogsSource();
    case "darwin":
    case "win32":
      throw new Error(`平台适配尚未实现:${process.platform}(plan.md Phase 7/8)`);
    default:
      throw new Error(`不支持的平台:${process.platform}`);
  }
}
