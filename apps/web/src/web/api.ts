/** API 客户端(类型来自 @netwatch/shared,改后端返回类型编译期即报错)+ SSE 实时订阅 */
import { useEffect, useState } from "react";
import type { AlertRow, DestinationProfile, LivePayload, RulesFile, TopDestinationRow, TopProcessRow } from "@netwatch/shared";

export type Range = "1h" | "24h" | "7d";

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const fetchTopProcesses = (range: Range): Promise<TopProcessRow[]> => json(`/api/top/processes?range=${range}&limit=10`);
export const fetchTopDestinations = (range: Range): Promise<TopDestinationRow[]> => json(`/api/top/destinations?range=${range}&limit=10`);
export const fetchDestinationProfile = (ip: string, range: Range): Promise<DestinationProfile> =>
  json(`/api/destination/${encodeURIComponent(ip)}?range=${range}`);
export const fetchAlerts = (): Promise<AlertRow[]> => json("/api/alerts?limit=100");
export const fetchRules = (): Promise<RulesFile> => json("/api/rules");

export interface HistorySeries {
  points: Array<Record<string, number>>;
  series: Array<{ name: string; total: number }>;
}

export const fetchHistory = (range: Range, groupBy: "process" | "destination"): Promise<HistorySeries> =>
  json(`/api/history/series?range=${range}&groupBy=${groupBy}&metric=sent`);

export function updateWhitelist(action: "add" | "remove", process: string, remoteIp: string): Promise<RulesFile> {
  return fetch("/api/rules/whitelist", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, process, remoteIp }),
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<RulesFile>;
  });
}

/** SSE 实时订阅:EventSource 断线由浏览器自动重连;stale = 快照超过 5s 未更新(采集端离线) */
export function useLive(): { live: LivePayload | null; connected: boolean } {
  const [live, setLive] = useState<LivePayload | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource("/api/live");
    es.addEventListener("snapshot", (e) => {
      setConnected(true);
      setLive(JSON.parse((e as MessageEvent).data) as LivePayload);
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);
  const stale = live !== null && Date.now() - live.at > 5_000;
  return { live, connected: connected && !stale };
}
