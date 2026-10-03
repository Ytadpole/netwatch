/** 实时快照读取(§5):只读轮询 live_snapshot 行;采集端未运行/数据异常返回 null */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { LivePayloadSchema, type LivePayload } from "@netwatch/shared";

export class LiveReader {
  private db: DatabaseSync | null = null;
  private stmt: StatementSync | null = null;

  constructor(private readonly dbPath: string) {}

  read(): LivePayload | null {
    try {
      if (this.db === null) {
        if (!existsSync(this.dbPath)) return null;
        this.db = new DatabaseSync(this.dbPath, { readOnly: true });
        this.stmt = this.db.prepare("SELECT at, json FROM live_snapshot WHERE id = 1");
      }
      const row = this.stmt!.get() as { at: number; json: string } | undefined;
      if (row === undefined) return null;
      return LivePayloadSchema.parse(JSON.parse(row.json));
    } catch {
      return null; // 库缺失/表未建/快照损坏 → 前端按"采集端离线"处理
    }
  }
}
