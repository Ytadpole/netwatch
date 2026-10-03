/** 速率/字节数格式化(展示端;与采集端终端渲染规则一致:等宽数字见 CSS tabular-nums) */

export function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 ** 2) return `${(bytesPerSec / 1024).toFixed(2)} KB/s`;
  if (bytesPerSec < 1024 ** 3) return `${(bytesPerSec / 1024 ** 2).toFixed(2)} MB/s`;
  return `${(bytesPerSec / 1024 ** 3).toFixed(2)} GB/s`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 堆叠面积图配色(琥珀=上传主基调,按系列名哈希取色;"归因失败"固定灰、"其他"固定深灰) */
const PALETTE = ["#f5a623", "#4c9ffe", "#38c793", "#c678dd", "#e5534b", "#56b6c2", "#d9a53f", "#98c379"];

export function colorFor(name: string): string {
  if (name === "(归因失败)") return "#6b7280";
  if (name === "其他") return "#3a404d";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
