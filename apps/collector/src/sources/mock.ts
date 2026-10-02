import type { TrafficEvent, TrafficSource, TrafficSourceCapabilities } from "@netwatch/shared";

/**
 * Mock 数据源:无 root 的端到端验证路径(开发/演示用)。
 * 事件形态对齐本机真实画像:含环回代理两跳(chrome → 127.0.0.1:7897 → 真实远端)、
 * 局域网同步、偶发 unknown-flow 与"新目的地"(验证 NEW 徽标)。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FlowSpec {
  process: string;
  pid: number | null;
  ip: string;
  port: number;
  /** 每拍上传字节的基线范围 */
  sentMin: number;
  sentMax: number;
  /** 每拍上传有产出的概率(模拟间歇流量) */
  active: number;
  /** 新目的地进程池:偶发换一个 203.0.113.x,触发 NEW 徽标 */
  novel?: boolean;
}

const FLOWS: FlowSpec[] = [
  { process: "chrome", pid: 1234, ip: "127.0.0.1", port: 7897, sentMin: 40_000, sentMax: 260_000, active: 0.9 }, // 走环回代理
  { process: "mihomo", pid: 777, ip: "104.20.23.154", port: 443, sentMin: 38_000, sentMax: 250_000, active: 0.9 }, // 代理的真实出网(两跳对应)
  { process: "chrome", pid: 1234, ip: "108.177.10.99", port: 443, sentMin: 5_000, sentMax: 40_000, active: 0.5 },
  { process: "nextcloud-sync", pid: 2045, ip: "192.168.1.10", port: 443, sentMin: 120_000, sentMax: 900_000, active: 0.6 },
  { process: "code", pid: 3311, ip: "140.82.121.4", port: 443, sentMin: 800, sentMax: 9_000, active: 0.3 },
  { process: "backup-agent", pid: 5501, ip: "203.0.113.2", port: 443, sentMin: 200_000, sentMax: 3_000_000, active: 0.08, novel: true }, // 冷门进程偶发大上传
];

const randInt = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1));

export class MockSource implements TrafficSource {
  readonly capabilities: TrafficSourceCapabilities = { perProcessBytes: true, dnsObservation: false };

  private stopping = false;
  private novelIp = 2;

  async *events(): AsyncGenerator<TrafficEvent> {
    while (!this.stopping) {
      await sleep(1_000);
      if (this.stopping) return;
      yield* this.tick(Date.now());
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
  }

  private *tick(at: number): Generator<TrafficEvent> {
    for (const f of FLOWS) {
      if (Math.random() > f.active) continue;
      const sent = randInt(f.sentMin, f.sentMax);
      const ip = f.novel ? `203.0.113.${this.novelIp % 200 + 2}` : f.ip;
      if (f.novel && Math.random() < 0.25) this.novelIp++; // 偶发换个新目的地
      yield { kind: "flow", pid: f.pid, process: f.process, remoteIp: ip, remotePort: f.port, sentBytes: sent, recvBytes: Math.round(sent * 0.4), at };
    }
    // 归因失败的外传(每 ~5 拍一次)
    if (Math.random() < 0.2) {
      yield { kind: "unknown-flow", remoteIp: "198.51.100.7", remotePort: 443, sentBytes: randInt(15_000, 120_000), recvBytes: randInt(1_000, 8_000), at };
    }
  }
}
