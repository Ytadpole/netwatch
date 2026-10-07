import { useEffect, useState } from "react";
import type { RulesFile } from "@netwatch/shared";
import { fetchAlerts, fetchRules, updateWhitelist } from "../api.js";
import { fmtBytes, fmtClock } from "../format.js";
import type { AlertRow } from "@netwatch/shared";

export function AlertsView() {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [rules, setRules] = useState<RulesFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ process: "", remoteIp: "" });

  const refresh = (): void => {
    Promise.all([fetchAlerts(), fetchRules()])
      .then(([a, r]) => {
        setAlerts(a);
        setRules(r);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(refresh, []);

  const editWhitelist = async (action: "add" | "remove", process: string, remoteIp: string): Promise<void> => {
    try {
      setRules(await updateWhitelist(action, process, remoteIp));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const severityName: Record<string, string> = { info: "提示", warn: "警告", high: "严重" };

  return (
    <div className="alerts">
      {error !== null ? <p className="error">{error}</p> : null}

      <section className="panel">
        <h3>告警({alerts.length})</h3>
        {alerts.length === 0 ? (
          <p className="empty">暂无告警——要么很安静,要么规则阈值太宽。</p>
        ) : (
          <ul className="alert-list">
            {alerts.map((a) => (
              <li key={a.id} className={`alert sev-${a.severity}`}>
                <span className="sev">{severityName[a.severity] ?? a.severity}</span>
                <span className="at">{fmtClock(a.at)}</span>
                <span className="rule">{a.rule}</span>
                <span className="msg">{typeof (a.detail as { message?: unknown })?.message === "string" ? String((a.detail as { message: string }).message) : "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="twocol">
        <section className="panel">
          <h3>规则(阈值)</h3>
          {rules === null ? (
            <p className="empty">加载中…</p>
          ) : (
            <table>
              <tbody>
                <tr>
                  <td>new-destination</td>
                  <td className="num">{rules.newDestination.enabled ? `新公网目的地;当分钟 > ${fmtBytes(rules.newDestination.escalateBytesPerMin)} 升级` : "关闭"}</td>
                </tr>
                <tr>
                  <td>volume-threshold</td>
                  <td className="num">
                    {rules.volumeThreshold.enabled ? `${fmtBytes(rules.volumeThreshold.bytesPer10min)}/10min 或 ${fmtBytes(rules.volumeThreshold.bytesPerHour)}/h` : "关闭"}
                  </td>
                </tr>
                <tr>
                  <td>unknown-process</td>
                  <td className="num">
                    {rules.unknownProcess.enabled
                      ? `连续 ${rules.unknownProcess.consecutiveWindows} 窗口且 > ${fmtBytes(rules.unknownProcess.bytesPerMin)}/min`
                      : "关闭"}
                  </td>
                </tr>
                <tr>
                  <td>beacon</td>
                  <td className="num">
                    {rules.beacon.enabled
                      ? `${rules.beacon.windowMin}min 窗口 ≥${rules.beacon.minSamples} 次、均值 ≤ ${fmtBytes(rules.beacon.maxAvgBytes)}/次、间隔抖动 ≤ ${Math.round(rules.beacon.gapJitter * 100)}%`
                      : "关闭"}
                  </td>
                </tr>
                <tr>
                  <td>baseline-anomaly</td>
                  <td className="num">
                    {rules.baseline.enabled
                      ? `学习型:今日上传 > 近 ${rules.baseline.historyDays - 1} 天活跃日均值 + ${rules.baseline.sigma}σ(且 > 均值 × ${rules.baseline.minRatio}、≥ ${fmtBytes(rules.baseline.floorBytes)})`
                      : "关闭"}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          <p className="muted hint">阈值/通知修改:编辑规则 JSON 后向采集端发 SIGHUP(或重启采集端)。</p>
        </section>

        <section className="panel">
          <h3>白名单(进程 × 目的 IP)</h3>
          {rules === null ? (
            <p className="empty">加载中…</p>
          ) : (
            <>
              <table>
                <thead>
                  <tr>
                    <th>进程</th>
                    <th>目的 IP</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rules.whitelist.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="muted">
                        (空)
                      </td>
                    </tr>
                  ) : (
                    rules.whitelist.map((w, i) => (
                      <tr key={`${w.process}|${w.remoteIp}|${i}`}>
                        <td>{w.process}</td>
                        <td>{w.remoteIp}</td>
                        <td>
                          <button className="del" onClick={() => void editWhitelist("remove", w.process, w.remoteIp)}>
                            删除
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <form
                className="wl-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (form.process !== "" && form.remoteIp !== "") {
                    void editWhitelist("add", form.process, form.remoteIp);
                    setForm({ process: "", remoteIp: "" });
                  }
                }}
              >
                <input placeholder="进程名(如 nextcloud-sync)" value={form.process} onChange={(e) => setForm({ ...form, process: e.target.value })} />
                <input placeholder="目的 IP(或 * )" value={form.remoteIp} onChange={(e) => setForm({ ...form, remoteIp: e.target.value })} />
                <button type="submit">添加</button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
