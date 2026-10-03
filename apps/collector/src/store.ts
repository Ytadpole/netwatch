import { DatabaseSync, type StatementSync } from "node:sqlite";
import { homedir } from "node:os";
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
}

export interface DestinationSighting {
  remoteIp: string;
  /** 事件时刻(毫秒),非落盘时刻 */
  firstSeen: number;
}

export const PID_SENTINEL = -1; // flow.pid=null → -1(进程名已知、PID 缺失)

export function defaultDbPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(base, "netwatch", "netwatch.db");
}

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
CREATE INDEX IF NOT EXISTS idx_flow_minutes_minute ON flow_minutes(minute);
`;

export class Store {
  private readonly db: DatabaseSync;
  private readonly stmtFlush: StatementSync;
  private readonly stmtDestination: StatementSync;
  private readonly stmtDestFirstSeen: StatementSync;
  private readonly stmtAlertInsert: StatementSync;

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
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(minute, kind, pid, process, remote_ip, remote_port)
      DO UPDATE SET sent = excluded.sent, recv = excluded.recv
    `);
    this.stmtDestination = this.db.prepare(`
      INSERT INTO destinations (remote_ip, first_seen) VALUES (?, ?)
      ON CONFLICT(remote_ip) DO NOTHING
    `);
    this.stmtDestFirstSeen = this.db.prepare("SELECT first_seen FROM destinations WHERE remote_ip = ?");
    this.stmtAlertInsert = this.db.prepare("INSERT INTO alerts (at, rule, severity, detail) VALUES (?, ?, ?, ?)");
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
        r.sent,
        r.recv,
      );
    }
  }

  /** 首见目的地;已存在则保留最早的 first_seen(富化列 Phase 5 补写) */
  recordDestinations(sightings: DestinationSighting[]): void {
    for (const s of sightings) {
      this.stmtDestination.run(s.remoteIp, s.firstSeen);
    }
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
  rule: "new-destination" | "volume-threshold" | "unknown-process";
  severity: "info" | "warn" | "high";
  detail: unknown;
}
