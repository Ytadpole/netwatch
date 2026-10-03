/** 告警通知通道(§6):桌面 notify-send + webhook;失败静默(通知不该搞垮采集端) */

import { spawn } from "node:child_process";
import type { Alert } from "./engine.js";

export interface Notifier {
  readonly name: string;
  send(alert: Alert): void;
}

export function formatAlertText(alert: Alert): string {
  return `【netwatch·${alert.severity}】${alert.rule}:${alert.detail.message}`;
}

/** 无图形会话(DISPLAY/WAYLAND 均缺)或 notify-send 不可用时返回 null */
export function desktopNotifier(): Notifier | null {
  if (process.env.DISPLAY === undefined && process.env.WAYLAND_DISPLAY === undefined) return null;
  return {
    name: "desktop",
    send(alert: Alert): void {
      try {
        spawn("notify-send", ["netwatch", formatAlertText(alert)], { stdio: "ignore" }).on("error", () => {});
      } catch {
        // 通知失败不影响采集
      }
    },
  };
}

export function webhookNotifier(url: string): Notifier {
  return {
    name: "webhook",
    send(alert: Alert): void {
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...alert, text: formatAlertText(alert) }),
      }).catch(() => {
        // 网络失败静默;告警已入库,仪表盘可见
      });
    },
  };
}
