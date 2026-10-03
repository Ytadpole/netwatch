import { DatabaseSync } from "node:sqlite";
import { TopProcessRowSchema, TopDestinationRowSchema, type TopProcessRow, type TopDestinationRow } from "./schemas.js";

/**
 * 读库查询(Phase 2):展示侧入口,普通用户即可读。
 * 出库数据一律过 zod 校验(schema 在 packages/shared,Phase 4 API 复用);校验失败直接抛错。
 */

export interface TopOptions {
  dbPath: string;
  /** 回看秒数(1h/24h/7d) */
  rangeSec: number;
  limit?: number;
  now?: number;
}

function open(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

function assertParsed<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { message: string } } }, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success || r.data === undefined) {
    throw new Error(`读库数据未过 zod 校验:${r.error?.message ?? "unknown"}`);
  }
  return r.data;
}

/** Top 进程:区间内按 进程×kind 聚合;峰值取"单分钟上传"最大值 */
export function topProcesses(opts: TopOptions): TopProcessRow[] {
  const db = open(opts.dbPath);
  try {
    const since = Math.floor(((opts.now ?? Date.now()) - opts.rangeSec * 1000) / 60_000) * 60_000;
    const raw = db
      .prepare(
        `SELECT kind, pid, process,
                SUM(min_sent)  AS total_sent,
                SUM(min_recv)  AS total_recv,
                MAX(min_sent)  AS peak_minute_sent
         FROM (
           SELECT minute, kind, pid, process, SUM(sent) AS min_sent, SUM(recv) AS min_recv
           FROM flow_minutes WHERE minute >= ?
           GROUP BY minute, kind, pid, process
         )
         GROUP BY kind, pid, process
         ORDER BY total_sent DESC
         LIMIT ?`,
      )
      .all(since, opts.limit ?? 20) as Array<Record<string, unknown>>;
    return raw.map((r) =>
      assertParsed(TopProcessRowSchema, {
        kind: r.kind,
        pid: Number(r.pid),
        process: String(r.process),
        totalSent: Number(r.total_sent),
        totalRecv: Number(r.total_recv),
        peakMinuteSent: Number(r.peak_minute_sent),
      }),
    );
  } finally {
    db.close();
  }
}

/** Top 目的地:区间内按 remote_ip 聚合,LEFT JOIN destinations 取富化/首见(未知归因的流量也计入) */
export function topDestinations(opts: TopOptions): TopDestinationRow[] {
  const db = open(opts.dbPath);
  try {
    const since = Math.floor(((opts.now ?? Date.now()) - opts.rangeSec * 1000) / 60_000) * 60_000;
    const raw = db
      .prepare(
        `SELECT f.remote_ip             AS remote_ip,
                d.domain, d.country, d.asn, d.first_seen,
                SUM(f.min_sent)         AS total_sent,
                SUM(f.min_recv)         AS total_recv,
                MAX(f.min_sent)         AS peak_minute_sent
         FROM (
           SELECT minute, remote_ip, SUM(sent) AS min_sent, SUM(recv) AS min_recv
           FROM flow_minutes WHERE minute >= ?
           GROUP BY minute, remote_ip
         ) f
         LEFT JOIN destinations d ON d.remote_ip = f.remote_ip
         GROUP BY f.remote_ip
         ORDER BY total_sent DESC
         LIMIT ?`,
      )
      .all(since, opts.limit ?? 20) as Array<Record<string, unknown>>;
    return raw.map((r) =>
      assertParsed(TopDestinationRowSchema, {
        remoteIp: String(r.remote_ip),
        domain: r.domain === null || r.domain === undefined ? undefined : String(r.domain),
        country: r.country === null || r.country === undefined ? undefined : String(r.country),
        asn: r.asn === null || r.asn === undefined ? undefined : String(r.asn),
        firstSeen: r.first_seen === null || r.first_seen === undefined ? undefined : Number(r.first_seen),
        totalSent: Number(r.total_sent),
        totalRecv: Number(r.total_recv),
        peakMinuteSent: Number(r.peak_minute_sent),
      }),
    );
  } finally {
    db.close();
  }
}
