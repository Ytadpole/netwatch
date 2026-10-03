import { useEffect, useState } from "react";
import { fetchAlerts, useLive, type Range } from "./api.js";
import { fmtRate } from "./format.js";
import { LiveView } from "./views/Live.js";
import { HistoryView } from "./views/History.js";
import { AlertsView } from "./views/Alerts.js";

type View = "live" | "history" | "alerts";

function viewFromUrl(): View {
  const v = new URLSearchParams(location.search).get("view");
  return v === "history" || v === "alerts" ? v : "live";
}

const NAV: Array<{ key: View; label: string }> = [
  { key: "live", label: "实时" },
  { key: "history", label: "历史" },
  { key: "alerts", label: "告警" },
];

export function App() {
  const [view, setView] = useState<View>(viewFromUrl);
  const { live, connected } = useLive();

  const nav = (v: View): void => {
    setView(v);
    const u = new URLSearchParams(location.search);
    u.set("view", v);
    history.replaceState(null, "", `?${u.toString()}`);
  };

  // 全局告警计数(顶部 🔔);10s 轮询,与告警视图的拉取解耦
  const [alertCount, setAlertCount] = useState(0);
  useEffect(() => {
    let stopped = false;
    const tick = (): void => {
      fetchAlerts()
        .then((a) => {
          if (!stopped) setAlertCount(a.length);
        })
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  // capabilities 驱动降级渲染(§5.1):先做逻辑不做平台
  const caps = live?.capabilities ?? { perProcessBytes: true, dnsObservation: false };

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">● netwatch</span>
        <span className="rates">
          {caps.perProcessBytes ? (
            <>
              <b className="up">↑ {fmtRate(live?.totalSentRate ?? 0)}</b>
              <b className="down">↓ {fmtRate(live?.totalRecvRate ?? 0)}</b>
            </>
          ) : (
            <span className="muted">本平台无每进程字节数(降级模式)</span>
          )}
        </span>
        <span className={`conn ${connected ? "on" : "off"}`}>{connected ? "已连接" : "采集端离线"}</span>
        <button className="bell" onClick={() => nav("alerts")}>
          🔔 {alertCount}
        </button>
      </header>
      <div className="body">
        <nav className="sidenav">
          {NAV.map((n) => (
            <button key={n.key} className={view === n.key ? "active" : ""} onClick={() => nav(n.key)}>
              {n.label}
            </button>
          ))}
        </nav>
        <main className="content">
          {view === "live" && <LiveView live={live} caps={caps} />}
          {view === "history" && <HistoryView initialRange={"24h" as Range} />}
          {view === "alerts" && <AlertsView />}
        </main>
      </div>
    </div>
  );
}
