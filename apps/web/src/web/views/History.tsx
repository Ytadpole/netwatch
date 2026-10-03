import { useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Range } from "../api.js";
import { fetchHistory, fetchTopDestinations, fetchTopProcesses, type HistorySeries } from "../api.js";
import { colorFor, fmtBytes, fmtClock } from "../format.js";
import type { TopDestinationRow, TopProcessRow } from "@netwatch/shared";
import { CATEGORY_LABELS } from "@netwatch/shared/classify";

const RANGES: Range[] = ["1h", "24h", "7d"];

export function HistoryView({ initialRange }: { initialRange: Range }) {
  const [range, setRange] = useState<Range>(initialRange);
  const [groupBy, setGroupBy] = useState<"process" | "destination">("process");
  const [hist, setHist] = useState<HistorySeries | null>(null);
  const [topProc, setTopProc] = useState<TopProcessRow[]>([]);
  const [topDest, setTopDest] = useState<TopDestinationRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    setError(null);
    Promise.all([fetchHistory(range, groupBy), fetchTopProcesses(range), fetchTopDestinations(range)])
      .then(([h, p, d]) => {
        if (stopped) return;
        setHist(h);
        setTopProc(p);
        setTopDest(d);
      })
      .catch((err: unknown) => {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stopped = true;
    };
  }, [range, groupBy]);

  return (
    <div className="history">
      <div className="toolbar">
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r} className={range === r ? "active" : ""} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        <div className="seg">
          <button className={groupBy === "process" ? "active" : ""} onClick={() => setGroupBy("process")}>
            按进程
          </button>
          <button className={groupBy === "destination" ? "active" : ""} onClick={() => setGroupBy("destination")}>
            按目的地
          </button>
        </div>
      </div>

      {error !== null ? <p className="error">{error}</p> : null}

      <section className="panel">
        <h3>分钟级上传量{groupBy === "destination" ? "(按目的地)" : "(按进程)"}</h3>
        {hist === null ? (
          <p className="empty">加载中…</p>
        ) : hist.points.length === 0 ? (
          <p className="empty">区间内无落库数据(采集端需运行并跨过整分钟)。</p>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={hist.points} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
              <XAxis dataKey="minute" tickFormatter={(m: number) => fmtClock(m).slice(0, 5)} stroke="#8a93a5" />
              <YAxis tickFormatter={(v: number) => fmtBytes(v)} stroke="#8a93a5" width={78} />
              <Tooltip
                formatter={(v) => fmtBytes(Number(v))}
                labelFormatter={(m) => fmtClock(Number(m))}
                contentStyle={{ background: "#171a21", border: "1px solid #262b36", borderRadius: 6, color: "#d7dce5" }}
              />
              {hist.series.map((s) => (
                <Area key={s.name} dataKey={s.name} stackId="1" stroke="none" fill={colorFor(s.name)} isAnimationActive={false} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </section>

      <div className="twocol">
        <section className="panel">
          <h3>Top 进程(上传)</h3>
          <table>
            <thead>
              <tr>
                <th>进程</th>
                <th className="num">上传</th>
                <th className="num">峰值/分钟</th>
              </tr>
            </thead>
            <tbody>
              {topProc.map((r) => (
                <tr key={`${r.kind}|${r.pid}|${r.process}`}>
                  <td>{r.kind === "unknown-flow" ? "(归因失败)" : r.process}</td>
                  <td className="num">{fmtBytes(r.totalSent)}</td>
                  <td className="num">{fmtBytes(r.peakMinuteSent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h3>Top 目的地(上传)</h3>
          <table>
            <thead>
              <tr>
                <th>目的地</th>
                <th className="num">上传</th>
                <th className="num">首见</th>
              </tr>
            </thead>
            <tbody>
              {topDest.map((r) => (
                <tr key={r.remoteIp}>
                  <td>
                    {r.remoteIp}
                    {r.domain !== undefined ? <span className="muted"> · {r.domain}</span> : null}
                    {r.category !== undefined ? <span className="badge">{CATEGORY_LABELS[r.category]}</span> : null}
                  </td>
                  <td className="num">{fmtBytes(r.totalSent)}</td>
                  <td className="num">{r.firstSeen != null ? fmtClock(r.firstSeen) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
