/** 进程画像(§11):/proc 抽取进程可执行路径与启动时刻;路径可疑(临时目录/已删除二进制)判定 */

import { readFileSync, readlinkSync } from "node:fs";

export interface ProcessInfo {
  /** 可执行文件绝对路径(readlink /proc/<pid>/exe);二进制已被删除时带 " (deleted)" 后缀 */
  exePath: string;
  /** 进程启动时刻(纪元毫秒,由 stat 字段 22 starttime × tick + btime 推算) */
  startedAt?: number;
}

/** pid → 进程画像;查不到(权限/已退出/mock)返回 null */
export type ProcessInfoLookup = (pid: number) => ProcessInfo | null;

const SUSPICIOUS_PREFIXES = ["/tmp/", "/dev/shm/", "/var/tmp/", "/run/"];

/** 路径可疑:落在临时/运行时目录,或二进制已删除(落地即删是常见恶意样本形态) */
export function isSuspiciousPath(exePath: string): boolean {
  if (exePath.endsWith("(deleted)")) return true;
  return SUSPICIOUS_PREFIXES.some((p) => exePath.startsWith(p));
}

/** 读 /proc 的进程画像;结果按 pid 缓存(exe 与启动时刻在进程生命周期内不变) */
export class ProcessInspector {
  private readonly cache = new Map<number, ProcessInfo | null>();
  /** undefined = 尚未读取;null = 读取失败(无 /proc/stat 环境) */
  private bootTime: number | null | undefined;

  constructor(private readonly procRoot = "/proc") {}

  inspect(pid: number): ProcessInfo | null {
    const hit = this.cache.get(pid);
    if (hit !== undefined) return hit;
    let info: ProcessInfo | null = null;
    try {
      const exePath = readlinkSync(`${this.procRoot}/${pid}/exe`);
      const startedAt = this.readStartedAt(pid);
      info = startedAt === undefined ? { exePath } : { exePath, startedAt };
    } catch {
      info = null; // EACCES(他人进程)/ ESRCH(已退出)
    }
    this.cache.set(pid, info);
    return info;
  }

  /** stat 字段 22 starttime(开机后时钟 tick)× tick 时长 + 开机时刻 → 纪元毫秒;CLK_TCK 取常规值 100 */
  private readStartedAt(pid: number): number | undefined {
    try {
      const stat = readFileSync(`${this.procRoot}/${pid}/stat`, "utf8");
      // comm 字段可能含空格与括号,从最后一个 ')' 之后取字段 3 起的剩余部分
      const rest = stat.slice(stat.lastIndexOf(")") + 2);
      const starttime = Number(rest.split(" ")[19]); // 字段 22 - 字段 3 → 下标 19
      if (!Number.isFinite(starttime)) return undefined;
      const btime = this.readBootTime();
      if (btime === undefined || btime === null) return undefined;
      return btime * 1000 + Math.floor((starttime / 100) * 1000);
    } catch {
      return undefined;
    }
  }

  private readBootTime(): number | null | undefined {
    if (this.bootTime !== undefined) return this.bootTime;
    try {
      const line = readFileSync(`${this.procRoot}/stat`, "utf8")
        .split("\n")
        .find((l) => l.startsWith("btime "));
      this.bootTime = line === undefined ? null : Number(line.slice(6));
    } catch {
      this.bootTime = null;
    }
    return this.bootTime;
  }
}
