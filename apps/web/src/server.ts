#!/usr/bin/env node
/**
 * netwatch web(Phase 4,展示端,普通用户):Hono REST + SSE,静态托管 React 仪表盘。
 * 只读 SQLite(采集端是唯一写入方,§5);环境变量 NETWATCH_DB / NETWATCH_RULES / NETWATCH_WEB_PORT。
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AlertRowSchema,
  defaultDbPath,
  defaultRulesPath,
  LivePayloadSchema,
  TopProcessRowSchema,
  TopDestinationRowSchema,
} from "@netwatch/shared";
import { historySeries } from "./history.js";
import { LiveReader } from "./live.js";
import { readRulesFile, updateWhitelist } from "./rules-file.js";

const dbPath = process.env.NETWATCH_DB ?? defaultDbPath();
const rulesPath = process.env.NETWATCH_RULES ?? defaultRulesPath();
const port = Number(process.env.NETWATCH_WEB_PORT ?? 8787);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseRange(raw: string | undefined): number {
  const m = /^(\d+)(m|h|d)$/.exec(raw ?? "1h");
  if (m === null) throw new Error("range 支持 10m / 1h / 24h / 7d");
  return Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "d" ? 86400 : 60);
}

function openReadonly(): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

const RANGE_RE = /^(\d+)(m|h|d)$/;
const app = new Hono();

app.get("/api/live", (c) =>
  streamSSE(c, async (s) => {
    const reader = new LiveReader(dbPath);
    let lastJson = "";
    let ticks = 0;
    while (!c.req.raw.signal.aborted) {
      const payload = reader.read();
      if (payload !== null) {
        const json = JSON.stringify(payload);
        if (json !== lastJson) {
          lastJson = json;
          await s.writeSSE({ event: "snapshot", data: json });
        }
      }
      ticks++;
      if (ticks % 15 === 0) await s.writeSSE({ event: "ping", data: String(Date.now()) });
      await sleep(1_000);
    }
  }),
);

app.get("/api/top/processes", (c) => {
  let rangeSec: number;
  try {
    rangeSec = parseRange(c.req.query("range"));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  const db = openReadonly();
  try {
    const since = Math.floor((Date.now() - rangeSec * 1000) / 60_000) * 60_000;
    const raw = db
      .prepare(
        `SELECT kind, pid, process,
                SUM(min_sent) AS total_sent, SUM(min_recv) AS total_recv, MAX(min_sent) AS peak_minute_sent
         FROM (SELECT minute, kind, pid, process, SUM(sent) AS min_sent, SUM(recv) AS min_recv
               FROM flow_minutes WHERE minute >= ? GROUP BY minute, kind, pid, process)
         GROUP BY kind, pid, process ORDER BY total_sent DESC LIMIT ?`,
      )
      .all(since, Number(c.req.query("limit") ?? 20)) as Array<Record<string, unknown>>;
    return c.json(
      raw.map((r) =>
        TopProcessRowSchema.parse({
          kind: r.kind,
          pid: Number(r.pid),
          process: String(r.process),
          totalSent: Number(r.total_sent),
          totalRecv: Number(r.total_recv),
          peakMinuteSent: Number(r.peak_minute_sent),
        }),
      ),
    );
  } finally {
    db.close();
  }
});

app.get("/api/top/destinations", (c) => {
  let rangeSec: number;
  try {
    rangeSec = parseRange(c.req.query("range"));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  const db = openReadonly();
  try {
    const since = Math.floor((Date.now() - rangeSec * 1000) / 60_000) * 60_000;
    const raw = db
      .prepare(
        `SELECT f.remote_ip AS remote_ip, d.domain, d.country, d.asn, d.first_seen,
                SUM(f.min_sent) AS total_sent, SUM(f.min_recv) AS total_recv, MAX(f.min_sent) AS peak_minute_sent
         FROM (SELECT minute, remote_ip, SUM(sent) AS min_sent, SUM(recv) AS min_recv
               FROM flow_minutes WHERE minute >= ? GROUP BY minute, remote_ip) f
         LEFT JOIN destinations d ON d.remote_ip = f.remote_ip
         GROUP BY f.remote_ip ORDER BY total_sent DESC LIMIT ?`,
      )
      .all(since, Number(c.req.query("limit") ?? 20)) as Array<Record<string, unknown>>;
    return c.json(
      raw.map((r) =>
        TopDestinationRowSchema.parse({
          remoteIp: String(r.remote_ip),
          domain: r.domain === null || r.domain === undefined ? undefined : String(r.domain),
          country: r.country === null || r.country === undefined ? undefined : String(r.country),
          asn: r.asn === null || r.asn === undefined ? undefined : String(r.asn),
          firstSeen: r.first_seen === null || r.first_seen === undefined ? undefined : Number(r.first_seen),
          totalSent: Number(r.total_sent),
          totalRecv: Number(r.total_recv),
          peakMinuteSent: Number(r.peak_minute_sent),
        }),
      ),
    );
  } finally {
    db.close();
  }
});

app.get("/api/history/series", (c) => {
  const groupBy = c.req.query("groupBy") === "destination" ? "destination" : "process";
  const metric = c.req.query("metric") === "recv" ? "recv" : "sent";
  let rangeSec: number;
  try {
    rangeSec = parseRange(c.req.query("range"));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  try {
    return c.json(historySeries(dbPath, { rangeSec, groupBy, metric }));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/api/alerts", (c) => {
  const db = openReadonly();
  try {
    const raw = db
      .prepare("SELECT id, at, rule, severity, detail FROM alerts ORDER BY id DESC LIMIT ?")
      .all(Number(c.req.query("limit") ?? 50)) as Array<Record<string, unknown>>;
    return c.json(
      raw.map((r) =>
        AlertRowSchema.parse({
          id: Number(r.id),
          at: Number(r.at),
          rule: String(r.rule),
          severity: String(r.severity),
          detail: r.detail === null ? undefined : (JSON.parse(String(r.detail)) as unknown),
        }),
      ),
    );
  } finally {
    db.close();
  }
});

app.get("/api/rules", (c) => {
  try {
    return c.json(readRulesFile(rulesPath));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

const whitelistBody = z.object({
  action: z.enum(["add", "remove"]),
  process: z.string().min(1),
  remoteIp: z.string().min(1),
});

app.put("/api/rules/whitelist", zValidator("json", whitelistBody), (c) => {
  const body = c.req.valid("json");
  try {
    return c.json(updateWhitelist(rulesPath, body.action, { process: body.process, remoteIp: body.remoteIp }));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// 静态托管前端构建产物 + SPA 回退;找不到 dist 时给出提示(先 npm run web:build)
const distRoot = existsSync(path.resolve(process.cwd(), "apps/web/dist")) ? "apps/web/dist" : "dist";
app.use("/assets/*", serveStatic({ root: distRoot }));
app.get("*", (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
  const index = path.resolve(process.cwd(), distRoot, "index.html");
  if (!existsSync(index)) {
    return c.text("前端未构建:先运行 npm run web:build", 503);
  }
  return c.html(readFileSync(index, "utf8"));
});

serve({ fetch: app.fetch, port }, (info) => {
  console.error(`netwatch web · http://127.0.0.1:${info.port} · 库:${dbPath} · 规则:${rulesPath}`);
});
