import { DatabaseSync } from "node:sqlite";
import {
  DestinationProfileSchema,
  TopProcessRowSchema,
  TopDestinationRowSchema,
  type DestinationProfile,
  type TopProcessRow,
  type TopDestinationRow,
} from "./schemas.js";
import { classifyDomain } from "./classify.js";

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
                COALESCE(d.domain, MAX(f.f_domain)) AS domain,
                d.country, d.asn, d.first_seen,
                SUM(f.min_sent)         AS total_sent,
                SUM(f.min_recv)         AS total_recv,
                MAX(f.min_sent)         AS peak_minute_sent
         FROM (
           SELECT minute, remote_ip, SUM(sent) AS min_sent, SUM(recv) AS min_recv, MAX(domain) AS f_domain
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
        category: classifyDomain(r.domain === null || r.domain === undefined ? undefined : String(r.domain)),
        totalSent: Number(r.total_sent),
        totalRecv: Number(r.total_recv),
        peakMinuteSent: Number(r.peak_minute_sent),
      }),
    );
  } finally {
    db.close();
  }
}

/** 目的地画像(§11):指定 remote_ip 的维表信息、区间汇总、进程分解与每分钟序列 */
export function destinationProfile(opts: TopOptions & { remoteIp: string }): DestinationProfile {
  const db = open(opts.dbPath);
  try {
    const since = Math.floor(((opts.now ?? Date.now()) - opts.rangeSec * 1000) / 60_000) * 60_000;
    const head = db
      .prepare(
        `SELECT f.remote_ip            AS remote_ip,
                COALESCE(d.domain, MAX(f.f_domain)) AS domain,
                d.country, d.asn, d.first_seen,
                SUM(f.min_sent)        AS total_sent,
                SUM(f.min_recv)        AS total_recv,
                MAX(f.min_sent)        AS peak_minute_sent
         FROM (
           SELECT minute, remote_ip, SUM(sent) AS min_sent, SUM(recv) AS min_recv, MAX(domain) AS f_domain
           FROM flow_minutes WHERE remote_ip = ? AND minute >= ?
           GROUP BY minute, remote_ip
         ) f
         LEFT JOIN destinations d ON d.remote_ip = f.remote_ip
         GROUP BY f.remote_ip`,
      )
      .all(opts.remoteIp, since) as Array<Record<string, unknown>>;
    if (head[0] === undefined) {
      // 区间内无流量:返回维表信息(若存在),汇总为零
      const d = db
        .prepare("SELECT remote_ip, domain, country, asn, first_seen FROM destinations WHERE remote_ip = ?")
        .get(opts.remoteIp) as Record<string, unknown> | undefined;
      return assertParsed(DestinationProfileSchema, {
        remoteIp: opts.remoteIp,
        domain: d?.domain ?? undefined,
        country: d?.country ?? undefined,
        asn: d?.asn ?? undefined,
        firstSeen: d?.first_seen ?? undefined,
        totalSent: 0,
        totalRecv: 0,
        peakMinuteSent: 0,
        processes: [],
        series: [],
      });
    }
    const h = head[0]!;
    const domain = h.domain === null || h.domain === undefined ? undefined : String(h.domain);
    const processes = db
      .prepare(
        `SELECT kind, pid, process,
                SUM(min_sent) AS total_sent,
                SUM(min_recv) AS total_recv,
                MAX(min_sent) AS peak_minute_sent
         FROM (
           SELECT minute, kind, pid, process, SUM(sent) AS min_sent, SUM(recv) AS min_recv
           FROM flow_minutes WHERE remote_ip = ? AND minute >= ?
           GROUP BY minute, kind, pid, process
         )
         GROUP BY kind, pid, process
         ORDER BY total_sent DESC`,
      )
      .all(opts.remoteIp, since) as Array<Record<string, unknown>>;
    const series = db
      .prepare(
        `SELECT minute, SUM(sent) AS min_sent, SUM(recv) AS min_recv
         FROM flow_minutes WHERE remote_ip = ? AND minute >= ?
         GROUP BY minute ORDER BY minute`,
      )
      .all(opts.remoteIp, since) as Array<Record<string, unknown>>;
    return assertParsed(DestinationProfileSchema, {
      remoteIp: String(h.remote_ip),
      domain,
      country: h.country === null || h.country === undefined ? undefined : String(h.country),
      asn: h.asn === null || h.asn === undefined ? undefined : String(h.asn),
      firstSeen: h.first_seen === null || h.first_seen === undefined ? undefined : Number(h.first_seen),
      category: classifyDomain(domain),
      totalSent: Number(h.total_sent),
      totalRecv: Number(h.total_recv),
      peakMinuteSent: Number(h.peak_minute_sent),
      processes: processes.map((r) => ({
        kind: r.kind,
        pid: Number(r.pid),
        process: String(r.process),
        totalSent: Number(r.total_sent),
        totalRecv: Number(r.total_recv),
        peakMinuteSent: Number(r.peak_minute_sent),
      })),
      series: series.map((r) => ({
        minute: Number(r.minute),
        sent: Number(r.min_sent),
        recv: Number(r.min_recv),
      })),
    });
  } finally {
    db.close();
  }
}
