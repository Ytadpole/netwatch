# netwatch 开发计划

> 依据 [design.md](./design.md)。每个 Phase 结束要能跑、能验收;Backlog(§11)不进任何 Phase,主线跑通后单独排。

## 约定

- 分支:`main` 保持可跑,功能直接提交(单人项目,不开 PR 流程)。
- 每个 Phase 开工前:把该 Phase 的验收标准贴进提交说明;验收不过不进下一阶段。
- 严格 TS(`tsconfig` 沿用 flashcards 那套 strict 配置),`npm run typecheck` 常绿。

---

## Phase 0 — Spike:验证数据源(0.5 天)

- [x] `sudo nethogs -t -d 2` 本机采样 ≥ 5 分钟 ✓(2026-10-04,样本 2348 行 + ss 旁路 6650 行,含受控流量)
- [x] 确认列含义与格式(0.8.7-2build2):数据行 `program/pid/uid\tsent\trecv`,**无远端地址列**;边界情况(unknown TCP/UDP 行、`Unknown connection:` 关闭瞬间、头部噪音)已记录于 spike-notes
- [x] 定稿 `TrafficSource` 接口与 `TrafficEvent` 判别联合(§3.4/3.5),写入 `packages/shared`(细化点见 `docs/samples/spike-notes.md`)
- [x] 顺带确认:ss 轮询兜底、DNS 观察在本机的可行路径(`spike-notes.md`;⚠️ 发现本机走环回代理 127.0.0.1:7897,"传给谁"富化需特殊处理)

**验收**:拿到真实样本;接口签名评审通过(自己读一遍:上层能否对平台零感知?)

## Phase 1 — 采集层 + CLI(1~2 天)

- [x] 初始化 monorepo(shared / collector / web 三包)(npm workspaces + 根 tsconfig.base;web 包随 Phase 4 建)
- [x] `sources/linux/`:nethogs 子进程管理(启动 / 崩溃退避重启 / SIGTERM 优雅退出)完成;行解析器骨架完成,**待 Phase 0 样本校准**(parse.ts 标注校准点)
- [x] 内存滚动窗口聚合(分钟桶 × 进程 × 目的地)+ 10s 速率窗 + NEW 首见(启动首屏批视为既有,避免满屏 NEW)
- [x] CLI:`netwatch-collector` 实时打印"谁在传"(对齐 §5.1:进程卡 / 目的地行 / 占比条 / 代理·局域网·NEW 徽标 / 归因失败卡置底);`--mock` 无 root 端到端跑通,确定性断言全过
- [x] 真实源端到端 ✓:采样证实 nethogs trace 无远端列,**主路径改为 ss 轮询**(design.md §3.1);`SsSource` 已实现,非 root 真实数据(本用户进程+环回跳)端到端验证通过;nethogs 解析器已按真实格式校准(全样本回放 2062 事件)
- [ ] 30 分钟稳定性验收(root 下长跑,SS/解析器内存与崩溃恢复)

**验收**:终端实时刷新 30 分钟无内存泄漏、无崩溃;重启后自动恢复。(待 root 实测)

## Phase 2 — 落库与查询(1 天)

- [x] SQLite 建表(`flow_minutes` / `destinations` / `alerts`,§4;node:sqlite + WAL;§4 契约已修订:补 remote_port 列、pid NOT NULL(-1 哨兵)、增 kind 列)
- [x] 聚合器定期落盘(`drainClosedMinutes` 整桶 REPLACE 幂等);首见目的地写 `destinations`(first_seen = 事件时刻)
- [x] 查询 CLI:`top 1h|24h|7d`(按进程/按目的地,`npm run query`)
- [x] 读库数据过 zod 校验(schema 在 packages/shared,Phase 4 API 复用)

**验收**:查询结果与 Phase 1 终端输出核对一致 ✓(mock 数据三方核对,19 项断言:总量 915000 不丢不重、峰值分钟、unknown 独立组、重复 flush 幂等);`destinations.first_seen` 正确 ✓(= 事件时刻)。真实源数据核对随 Phase 1(root)收口后补充。

## Phase 3 — 规则引擎 + 告警(1 天)

- [x] 三条规则:`new-destination` / `volume-threshold` / `unknown-process`(§6;`rules/engine.ts`,unknown 的连续窗口为滑窗近似)
- [x] 白名单(进程 × 目的 IP;支持 `remoteIp:"*"` 进程级静默),命中静默
- [x] 告警入库 + `notify-send` 桌面通知 + webhook(通知失败静默,不影响采集;无图形会话自动跳过桌面通知)
- [x] 类型化配置文件(zod 校验;`--rules=path`,缺省用 §6 内置默认阈值)

**验收**:人为触发三条规则各一次(新目的地 / 大上传 / UNKNOWN)均收到通知并入库。——node:test 三规则各触发一次全过(含白名单/冷却/严重度升级断言);mock 冒烟中 new-destination 与 unknown-process 实际触发并入库;volume-threshold 与桌面通知在 root 实测场景顺带确认。

## Phase 4 — Web 仪表盘(2~3 天)

- [x] Hono API:REST(SSE 实时流、Top、历史序列、告警/规则 CRUD,§5)+ zValidator(`apps/web/src/server.ts`;实时通道按 §5:采集端高频写 `live_snapshot` 行,Web 只读轮询后 SSE 推浏览器,采集端不开端口)
- [x] React 三视图:实时 / 历史 / 告警(线框见 §5.1,Recharts 堆叠面积图 + 手写 CSS 深色主题;URL 即状态 `?view=history&…`)
- [x] `capabilities` 驱动的降级渲染(先做逻辑不做平台:`perProcessBytes=false` 时隐藏速率列/图表)
- [x] SSE 断线自动重连(EventSource 原生重连 + 快照 >5s 视为离线的陈旧检测)

**验收**:浏览器实时刷新 ✓(mock 数据实况截图核对三视图);历史图与 CLI 查询一致 ✓(series 合计 60369961 = 库内直查 SUM,精确相等);断网 30s 恢复后 SSE 自动续上 ✓(重启 web 进程后页面自动回到"已连接")。真实 nethogs 数据下的最终确认随 Phase 1 收口。

## Phase 5 — 常驻 + 富化(1~2 天)

- [x] 环回代理两跳富化(§3.3.1,评审发现的告警污染问题先行解决):transit 识别(≥3 次字节相关命中确认)+ 两跳关联(±25% 字节/±5s 时窗)+ 规则引擎对 transit 进程豁免 new-destination;enrich.test.ts 4 项全过
- [x] systemd 双 unit 文件(`deploy/`,collector root / web 普通用户,含路径与用户占位注释);安装启用与"重启自恢复"验收待 root 部署
- [x] 反向 DNS 兜底(§3.3 优先级 3):`revdns.ts`(正/负缓存 6h、并发上限、超时负缓存、resolver 可注入);domain 落 `flow_minutes` 与 `destinations`(仅空值回填),查询侧 `COALESCE(维表, 分钟行)`
- [x] 目的地分类规则表(§11 静态表先行):shared/classify.ts,AI/网盘/对象存储后缀匹配(优先级 ai → 网盘 → 对象存储,泛云域启发式),topDestinations 输出 category,CLI 归属列与 Web 历史视图徽标;classify.test.ts 4 项
- [ ] GeoLite2 本地库 → 归属地/ASN(需要用户提供 GeoLite2 库文件);DNS 观察(§3.3 优先级 1/2,需 root)
- [x] `flow_minutes` 90 天清理任务(采集端每小时 `pruneOlderThan(90)`,destinations 维表保留)
- [x] README(安装、运行、systemd 部署、数据与隐私说明);截图待真实数据落地后补

**验收**:重启机器后自动恢复采集;仪表盘显示域名/归属地/分类徽标。

## Phase 6~8 — 平台与精确化(主线完成后排期)

- [ ] Phase 6:eBPF(Linux 精确统计,与 nethogs 交叉验证误差 < 5%)
- [ ] Phase 7:macOS 适配器(`nettop -P -L`,同一接口跑通)
- [ ] Phase 8:Windows ETW helper 评估 → 降级路径验证
- [x] §11 功能池第一项:Beacon 检测 ✓(规则引擎第 4 条 `beacon`,按「进程 × 目的地」滑窗统计节奏/体量/跨度,规则测试覆盖);下一个:目的地画像页

---

## 依赖关系

```
Phase 0 ──→ 1 ──→ 2 ──→ 3 ──→ 4 ──→ 5 ──→ 6/7/8(可并行选做)
                    │         │
                    └─ 2、3 可与 4 的前端并行(接口定稿后)
```

## 当前状态

- [x] 设计文档(design.md,含 §5.1 界面线框、§11 功能池)
- [x] 开发计划(plan.md,本文件)
- [x] **Phase 0 完成**:采样 + 格式确认 + 主路径定稿(ss 轮询);
- [ ] **→ Phase 1 收尾**:真实源(SsSource)端到端已验证;剩 root 下 30 分钟稳定性验收
- [x] Phase 2 完成(mock 数据验证):SQLite 落库 + 查询 CLI + zod 校验;真实数据核对随 Phase 1 收口
- [ ] **→ Phase 5 进行中**:两跳富化 ✓、反向 DNS 兜底 ✓、90 天清理 ✓、systemd unit 文件 ✓、README ✓;剩 GeoLite2(需库文件)/ DNS 观察(需 root)/ 实机部署验收
