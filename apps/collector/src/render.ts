/** 终端实时视图渲染(纯函数,对齐 design.md §5.1 实时视图信息密度) */

import type { LiveSnapshot } from "./aggregate.js";

export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";
export const YELLOW = "\x1b[33m";

export function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 ** 2) return `${(bytesPerSec / 1024).toFixed(2)} KB/s`;
  if (bytesPerSec < 1024 ** 3) return `${(bytesPerSec / 1024 ** 2).toFixed(2)} MB/s`;
  return `${(bytesPerSec / 1024 ** 3).toFixed(2)} GB/s`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** MM-DD HH:mm(本地时区),Top 表的首见/时间列用 */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function bar(share: number, width = 10): string {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * width);
  return "█".repeat(filled).padEnd(width, "░");
}

export interface RenderOptions {
  /** 标题里标注 mock 源 */
  mock?: boolean;
}

export function renderSnapshot(snap: LiveSnapshot, opts: RenderOptions = {}): string {
  const lines: string[] = [];
  const time = new Date(snap.at).toLocaleTimeString("zh-CN", { hour12: false });
  lines.push(`netwatch collector${opts.mock ? " (mock)" : ""} · ${time} · 全局 ↑ ${fmtRate(snap.totalSentRate)}  ↓ ${fmtRate(snap.totalRecvRate)}`);
  lines.push("─".repeat(72));
  for (const p of snap.processes) {
    const name = p.unattributed ? p.process : `${p.process}${p.pid !== null ? `(${p.pid})` : ""}`;
    const head = name.padEnd(22).slice(0, 22);
    const rate = `↑ ${fmtRate(p.sentRate)}`;
    lines.push(p.unattributed ? `${DIM}${head}${rate}  ← 规则引擎盯它${RESET}` : `${head}${rate}`);
    for (const d of p.destinations) {
      const badgePlain = d.loopback ? "[代理]" : d.lan ? "[局域网]" : d.isNew ? "NEW" : "";
      const badgeColored = badgePlain === "NEW" ? `${YELLOW}NEW${RESET}` : badgePlain;
      const destPlain = `  ${d.remoteIp}:${d.remotePort}${badgePlain ? " " + badgePlain : ""}`;
      // 先按纯文本对齐,再注入颜色(色码计入 padEnd 长度,不能直接 pad 彩色串)
      const padded = destPlain.padEnd(46);
      const display = badgePlain ? padded.replace(badgePlain, badgeColored) : padded;
      lines.push(`${display}${fmtRate(d.sentRate).padStart(10)}  ${bar(d.share)}`);
    }
  }
  if (snap.processes.length === 0) lines.push(`${DIM}(等待流量…)${RESET}`);
  return lines.join("\n") + "\n";
}
