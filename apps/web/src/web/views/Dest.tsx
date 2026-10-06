/** 目的地画像(§11):从历史视图 Top 目的地行钻取;URL 即状态(?view=dest&ip=…) */
import { useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Range } from "../api.js";
import { fetchDestinationProfile } from "../api.js";
import { fmtBytes, fmtClock } from "../format.js";
import type { DestinationProfile } from "@netwatch/shared";
import { CATEGORY_LABELS } from "@netwatch/shared/classify";

const RANGES: Range[] = ["1h", "24h", "7d"];

export function DestView({ onBack }: { onBack: () => void }) {
  const ip = new URLSearchParams(location.search).get("ip") ?? "";
  const [range, setRange] = useState<Range>("24h");
  const [profile, setProfile] = useState<DestinationProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    setError(null);
    setProfile(null);
    if (ip === "") return;
    fetchDestinationProfile(ip, range)
      .then((p) => {
        if (!stopped) setProfile(p);
      })
      .catch((err: unknown) => {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stopped = true;
    };
  }, [ip, range]);

  return (
    <div className="history">
      <div className="toolbar">
        <button className="seg" onClick={onBack}>
          ← 历史
        </button>
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r} className={range === r ? "active" : ""} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {ip === "" ? (
        <p className="empty">未指定目的地。</p>
      ) : error !== null ? (
        <p className="error">{error}</p>
      ) : profile === null ? (
        <p className="empty">加载中…</p>
      ) : (
        <>
          <section className="panel">
            <h3>
              {profile.remoteIp}
              {profile.domain !== undefined ? <span className="muted"> · {profile.domain}</span> : null}
              {profile.category !== undefined ? <span className="badge">{CATEGORY_LABELS[profile.category]}</span> : null}
            </h3>
            <p className="muted">
              首见 {profile.firstSeen != null ? fmtClock(profile.firstSeen) : "—"}
              {profile.country !== undefined ? ` · ${profile.country}` : ""}
              {profile.asn !== undefined ? ` · ${profile.asn}` : ""}
              {profile.country === undefined && profile.asn === undefined ? " · ASN/组织:GeoLite2 接入后显示" : ""}
            </p>
            <p>
              <b className="up">↑ {fmtBytes(profile.totalSent)}</b>
              <b className="down" style={{ marginLeft: 18 }}>
                ↓ {fmtBytes(profile.totalRecv)}
              </b>
              <span className="muted" style={{ marginLeft: 18 }}>
                峰值/分钟 {fmtBytes(profile.peakMinuteSent)}
              </span>
            </p>
          </section>

          <section className="panel">
            <h3>分钟级流量(该目的地)</h3>
            {profile.series.length === 0 ? (
              <p className="empty">区间内无落库数据。</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={profile.series} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
                  <XAxis dataKey="minute" tickFormatter={(m: number) => fmtClock(m).slice(0, 5)} stroke="#8a93a5" />
                  <YAxis tickFormatter={(v: number) => fmtBytes(v)} stroke="#8a93a5" width={78} />
                  <Tooltip
                    formatter={(v) => fmtBytes(Number(v))}
                    labelFormatter={(m) => fmtClock(Number(m))}
                    contentStyle={{ background: "#171a21", border: "1px solid #262b36", borderRadius: 6, color: "#d7dce5" }}
                  />
                  <Area dataKey="sent" stroke="#f5b04c" fill="#f5b04c" fillOpacity={0.35} isAnimationActive={false} />
                  <Area dataKey="recv" stroke="#5aa7ff" fill="#5aa7ff" fillOpacity={0.25} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </section>

          <section className="panel">
            <h3>哪些进程碰过它</h3>
            {profile.processes.length === 0 ? (
              <p className="empty">区间内无归因数据。</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>进程</th>
                    <th className="num">上传</th>
                    <th className="num">下载</th>
                    <th className="num">峰值/分钟</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.processes.map((r) => (
                    <tr key={`${r.kind}|${r.pid}|${r.process}`}>
                      <td>{r.kind === "unknown-flow" ? "(归因失败)" : r.process}</td>
                      <td className="num">{fmtBytes(r.totalSent)}</td>
                      <td className="num">{fmtBytes(r.totalRecv)}</td>
                      <td className="num">{fmtBytes(r.peakMinuteSent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
