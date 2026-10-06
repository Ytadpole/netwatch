import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * SQLite 落库(design.md §4):采集端(root)只写,展示端只读——SQLite 是两进程唯一耦合点。
 * 写入语义:closed minute 整桶 REPLACE(幂等,重放不翻倍);destinations 首见 OR IGNORE(保留最早)。
 */

export interface MinuteRow {
  kind: "flow" | "unknown-flow";
  pid: number | null;
  process: string;
  remoteIp: string;
  remotePort: number;
  sent: number;
  recv: number;
  /** 反向 DNS 富化(可选,未知留空) */
  domain?: string;
}

export interface DestinationSighting {
  remoteIp: string;
  /** 事件时刻(毫秒),非落盘时刻 */
  firstSeen: number;
  /** 反向 DNS 富化(可选;已存在行仅在其 domain 为空时回填) */
  domain?: string;
}

export const PID_SENTINEL = -1; // flow.pid=null → -1(进程名已知、PID 缺失)

// defaultDbPath 上移到 @netwatch/shared(两进程共用同一默认路径);此处保持再导出兼容
export { defaultDbPath } from "@netwatch/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flow_minutes (
  minute      INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  process     TEXT NOT NULL,
  remote_ip   TEXT NOT NULL,
  remote_port INTEGER NOT NULL,
  domain      TEXT,
  country     TEXT,
  asn         TEXT,
  sent        INTEGER NOT NULL,
  recv        INTEGER NOT NULL,
  PRIMARY KEY (minute, kind, pid, process, remote_ip, remote_port)
);
CREATE TABLE IF NOT EXISTS destinations (
  remote_ip TEXT PRIMARY KEY,
  domain TEXT, country TEXT, asn TEXT,
  first_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, at INTEGER,
  rule TEXT,
  severity TEXT,
  detail JSON
);
-- 实时快照(§5 进程间通道):采集端高频整行覆盖,展示端只读轮询后经 SSE 推浏览器
CREATE TABLE IF NOT EXISTS live_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flow_minutes_minute ON flow_minutes(minute);
`;

export class Store {
  private readonly db: DatabaseSync;
  private readonly stmtFlush: StatementSync;
  private readonly stmtDestination: StatementSync;
  private readonly stmtDestFirstSeen: StatementSync;
  private readonly stmtAlertInsert: StatementSync;
  private readonly stmtLiveSnapshot: StatementSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.stmtFlush = this.db.prepare(`
      INSERT INTO flow_minutes (minute, kind, pid, process, remote_ip, remote_port, domain, country, asn, sent, recv)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(minute, kind, pid, process, remote_ip, remote_port)
      DO UPDATE SET sent = excluded.sent, recv = excluded.recv
    `);
    this.stmtDestination = this.db.prepare(`
      INSERT INTO destinations (remote_ip, first_seen, domain) VALUES (?, ?, ?)
      ON CONFLICT(remote_ip) DO UPDATE SET
        domain = COALESCE(destinations.domain, excluded.domain)
    `);
    this.stmtDestFirstSeen = this.db.prepare("SELECT first_seen FROM destinations WHERE remote_ip = ?");
    this.stmtAlertInsert = this.db.prepare("INSERT INTO alerts (at, rule, severity, detail) VALUES (?, ?, ?, ?)");
    this.stmtLiveSnapshot = this.db.prepare(`
      INSERT INTO live_snapshot (id, at, json) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET at = excluded.at, json = excluded.json
    `);
  }

  /** 整分钟桶落库;同一桶重复 flush 以最新值覆盖(幂等) */
  flushMinute(minute: number, rows: MinuteRow[]): void {
    for (const r of rows) {
      this.stmtFlush.run(
        minute,
        r.kind,
        r.pid ?? PID_SENTINEL,
        r.kind === "unknown-flow" ? "" : r.process,
        r.remoteIp,
        r.remotePort,
        r.domain ?? null,
        r.sent,
        r.recv,
      );
    }
  }

  /** 实时快照(§5):采集端每采样周期覆盖写,展示端轮询此行 */
  writeLiveSnapshot(payload: unknown, at: number): void {
    this.stmtLiveSnapshot.run(at, JSON.stringify(payload));
  }

  /** 首见目的地;保留最早的 first_seen,domain 允许后补(原值为空才覆盖) */
  recordDestinations(sightings: DestinationSighting[]): void {
    for (const s of sightings) {
      this.stmtDestination.run(s.remoteIp, s.firstSeen, s.domain ?? null);
    }
  }

  /** 90 天清理(§9 磁盘增长对策):删除 minute 早于 days 天前的明细行,返回删除行数 */
  pruneOlderThan(days: number, now: number = Date.now()): number {
    const cutoff = Math.floor(now / 60_000) * 60_000 - days * 86_400_000;
    const r = this.db.prepare("DELETE FROM flow_minutes WHERE minute < ?").run(cutoff);
    return Number(r.changes);
  }

  /** 目的地首见查询(规则引擎 new-destination 判定用);无记录返回 null */
  destinationFirstSeen(remoteIp: string): number | null {
    const row = this.stmtDestFirstSeen.get(remoteIp) as { first_seen: number } | undefined;
    return row?.first_seen ?? null;
  }

  /** 告警入库(§6);detail 为触发快照对象,以 JSON 文本存储 */
  insertAlert(alert: AlertInsert): number {
    const r = this.stmtAlertInsert.run(alert.at, alert.rule, alert.severity, JSON.stringify(alert.detail));
    return Number(r.lastInsertRowid);
  }

  /** 最近告警(查询/测试用;新在前) */
  recentAlerts(limit = 20): Array<{ id: number; at: number; rule: string; severity: string; detail: unknown }> {
    const rows = this.db
      .prepare("SELECT id, at, rule, severity, detail FROM alerts ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      rule: String(r.rule),
      severity: String(r.severity),
      detail: r.detail === null ? undefined : (JSON.parse(String(r.detail)) as unknown),
    }));
  }

  close(): void {
    this.db.close();
  }
}

export interface AlertInsert {
  at: number;
  rule: "new-destination" | "volume-threshold" | "unknown-process" | "beacon";
  severity: "info" | "warn" | "high";
  detail: unknown;
}
