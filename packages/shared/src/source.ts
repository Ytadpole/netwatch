import type { TrafficEvent } from "./events.js";

/**
 * 平台能力声明(design.md §3.4/§5.1)。
 * 独立导出:Web 层做降级渲染时只 import 它,不依赖 TrafficSource。
 */
export interface TrafficSourceCapabilities {
  /** 能否给出每进程字节数。false:仪表盘隐藏速率列,告警只跑 new-destination(§3.4 Windows 降级) */
  readonly perProcessBytes: boolean;
  /** 能否做本机 DNS 观察。false:富化只退反向 DNS + GeoLite2 */
  readonly dnsObservation: boolean;
}

/**
 * 采集层唯一契约(§3.4)。平台差异(进程归因、速率→增量换算、子进程管理)
 * 全部封在实现内部;上层只消费 events() 产出的事件流,对平台零感知。
 *
 * 实现约定:
 * - events() 返回的是**活的单一事件流**,一个 TrafficSource 实例生命周期内只应消费一次;
 * - 流按采样节奏产出(如 nethogs 每 2s 一批),天然背压,消费方用 for await 即可;
 * - stop() 之后事件流以 done 结束;stop() 幂等,可安全重复调用。
 */
export interface TrafficSource {
  events(): AsyncGenerator<TrafficEvent>;
  readonly capabilities: TrafficSourceCapabilities;
  /** 优雅停止:回收子进程/句柄并结束事件流 */
  stop(): Promise<void>;
}
