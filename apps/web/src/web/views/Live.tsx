import type { LivePayload } from "@netwatch/shared";
import { fmtClock, fmtRate } from "../format.js";

interface Props {
  live: LivePayload | null;
  caps: { perProcessBytes: boolean; dnsObservation: boolean };
}

export function LiveView({ live, caps }: Props) {
  if (live === null) {
    return <p className="empty">等待采集端数据…(采集端需带 --db 落库运行,实时快照才会出现在库中)</p>;
  }
  if (live.processes.length === 0) {
    return <p className="empty">当前没有活跃流量。</p>;
  }
  return (
    <div className="cards">
      {live.processes.map((p) => (
        <section key={`${p.process}|${p.pid ?? "-"}`} className={p.unattributed ? "card unknown" : "card"}>
          <header className="card-head">
            <b>{p.process}</b>
            {!p.unattributed && p.pid !== null ? <span className="pid">({p.pid})</span> : null}
            <span className="card-rate">
              {caps.perProcessBytes ? `↑ ${fmtRate(p.sentRate)}` : `${p.destinations.length} 条连接`}
            </span>
          </header>
          {p.exePath !== undefined ? (
            <p className={`exe muted${p.suspicious ? " suspicious" : ""}`}>
              {p.suspicious ? "⚠ " : ""}
              {p.exePath}
              {p.startedAt !== undefined ? ` · 启动于 ${fmtClock(p.startedAt)}` : ""}
            </p>
          ) : null}
          {p.destinations.map((d) => (
            <div className="dest" key={`${d.remoteIp}:${d.remotePort}`}>
              <span className="ip">
                {d.remoteIp}:{d.remotePort}
              </span>
              {d.loopback ? <em className="badge">本地</em> : null}
              {d.lan ? <em className="badge">局域网</em> : null}
              {d.isNew ? <em className="badge new">NEW</em> : null}
              {caps.perProcessBytes ? (
                <>
                  <span className="rate">{fmtRate(d.sentRate)}</span>
                  <span className="bar">
                    <i style={{ width: `${Math.round(Math.min(1, Math.max(0, d.share)) * 100)}%` }} />
                  </span>
                </>
              ) : null}
            </div>
          ))}
          {p.unattributed ? <p className="unknown-hint">归因失败 — 规则引擎单独盯它(§6 unknown-process)</p> : null}
        </section>
      ))}
    </div>
  );
}
