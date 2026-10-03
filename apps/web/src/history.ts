/** 历史序列(§5 历史视图):flow_minutes → 分钟级堆叠面积图数据,Top N + 其他桶 */

import { DatabaseSync } from "node:sqlite";

export interface HistorySeries {
  /** Recharts 数据:每分钟一个点,{ minute, [进程/目的地名]: bytes } */
  points: Array<Record<string, number>>;
  /** 堆叠层(按区间总量降序);超过 topN 的归并为"其他" */
  series: Array<{ name: string; total: number }>;
}

export interface HistoryOptions {
  rangeSec: number;
  groupBy: "process" | "destination";
  metric: "sent" | "recv";
  topN?: number;
  now?: number;
}

function openReadOnly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function historySeries(dbPath: string, opts: HistoryOptions): HistorySeries {
  const db = openReadOnly(dbPath);
  const since = Math.floor(((opts.now ?? Date.now()) - opts.rangeSec * 1000) / 60_000) * 60_000;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .prepare(
        `SELECT minute, kind, pid, process, remote_ip, SUM(sent) AS s, SUM(recv) AS r
         FROM flow_minutes WHERE minute >= ?
         GROUP BY minute, kind, pid, process, remote_ip`,
      )
      .all(since) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }

  const metricKey = opts.metric === "sent" ? "s" : "r";
  const nameOf = (r: Record<string, unknown>): string =>
    r.kind === "unknown-flow" ? "(归因失败)" : opts.groupBy === "destination" ? String(r.remote_ip) : String(r.process);

  const totals = new Map<string, number>();
  for (const r of rows) {
    const name = nameOf(r);
    totals.set(name, (totals.get(name) ?? 0) + Number(r[metricKey]));
  }
  const topN = opts.topN ?? 8;
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const series = ranked.slice(0, topN).map(([name, total]) => ({ name, total }));
  const names = new Set(series.map((s) => s.name));
  const otherTotal = ranked.slice(topN).reduce((sum, [, total]) => sum + total, 0);
  if (ranked.length > topN) series.push({ name: "其他", total: otherTotal });

  const points = new Map<number, Record<string, number>>();
  for (const r of rows) {
    const minute = Number(r.minute);
    const name = nameOf(r);
    const key = names.has(name) ? name : "其他";
    let pt = points.get(minute);
    if (pt === undefined) {
      pt = { minute };
      points.set(minute, pt);
    }
    pt[key] = (pt[key] ?? 0) + Number(r[metricKey]);
  }

  return {
    points: [...points.entries()].sort((a, b) => a[0] - b[0]).map(([, pt]) => pt),
    series,
  };
}
