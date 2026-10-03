# netwatch — 工作区说明

进程级上传监控仪表盘:看什么程序在偷偷上传、传给谁、传了多少。Linux 首发,macOS 基本对齐,Windows 降级支持。

## 事实来源与当前状态

- 仓库为文档 + 契约包 + 采集端骨架(**mock 源可端到端跑**,真实 nethogs 源待样本校准)。动手前必读:
  - [docs/design.md](docs/design.md) — 设计全文。重点:§3 采集层(TrafficSource 契约)、§4 数据模型、§5 Web/API(§5.1 界面线框)、§6 规则引擎、§11 功能池。
  - [docs/plan.md](docs/plan.md) — Phase 0~8 计划,每个 Phase 末尾有验收标准。
  - [docs/samples/spike-notes.md](docs/samples/spike-notes.md) — spike 结论:数据源可行性、契约定稿决策、已知坑。
- 工作按 Phase 推进,**Phase 0 差采样一步**(sudo 脚本由用户终端执行),**Phase 1~4 骨架已完成**(mock 全链路:采集 → 落库 → 查询 → 规则告警 → Web 仪表盘;解析器待样本校准,root 实测验收未做)。开工前确认上一 Phase 验收已达成;完成事项勾掉 plan.md 复选框并更新其「当前状态」。

## 命令

- 根目录 npm workspaces(已初始化):
  - `npm run typecheck` — 全部包 strict TS 校验,必须常绿。
  - `npm run collector:mock` — mock 源跑采集 CLI,无需 root;`npm run collector` 为真实 nethogs 源,需要 root。
  - `npm run query -- top 1h [--by=destination]` — 读库查询 CLI,普通用户。
  - `npm run web:build && npm run web` — 构建并启动 Web 仪表盘(http://127.0.0.1:8787;`NETWATCH_DB`/`NETWATCH_RULES`/`NETWATCH_WEB_PORT` 可覆盖)。
  - `npm test` — collector 测试(node:test 经 tsx;规则引擎/落库断言)。
  - 需要改系统状态的只有 spike 采样脚本(装 nethogs、root 抓包),由用户自己在终端跑,agent 不要尝试 sudo。
- 前端构建产物仅 `apps/web/dist`(Vite,gitignore 之外需提交与否随 Phase 5 定);其余运行经 tsx。

## 进程间通道(§5,改代码前必读)

- 采集端(root)每秒把实时快照整行覆盖写进 `live_snapshot` 表;Web 端只读轮询该行,经 SSE 推浏览器——**采集端不开任何网络端口**。
- 规则配置文件(`~/.config/netwatch/rules.json`)由 Web 端写(白名单 CRUD)、采集端读(SIGHUP 热重载);两进程通过 `@netwatch/shared` 的 `RulesFileSchema`/`mergeRulesFile` 共享契约。
- SQLite(WAL)是两进程唯一耦合点:采集端只写,Web 端 `readOnly` 打开。

## 约定的仓库结构(Phase 1 时初始化)

```
packages/shared/   # 事件模型(TrafficEvent 判别联合)、zod schema、聚合类型(已存在)
apps/collector/    # 采集端,需 root;平台适配在 src/sources/<platform>/
apps/web/          # Hono API + React 仪表盘,普通用户
```

新代码落进这个骨架,不要在根目录堆文件。

## 架构红线

- **采集端与展示端是两个独立进程,SQLite 是唯一耦合点**。采集端(root)只写库,不得开网络端口;展示端不得要求高权限。
- **平台差异只允许存在于 `apps/collector/src/sources/<platform>/`**,对外只有 `createTrafficSource()`(§3.4)。上层(富化/聚合/规则/Web)只消费 `TrafficEvent`,不感知平台。
- 前端降级渲染由 `capabilities` 字段驱动,不写死平台判断。
- 接口/事件契约改动:先改 design.md,再改 `packages/shared`(`packages/shared/tsconfig.json` 是全仓严格 TS 配置的基准)。

## 技术约定

- Node ≥ 22 + TypeScript strict;存储 SQLite(node:sqlite 起步);API 用 Hono + zValidator + SSE;前端 React 19 + Vite + Recharts,不引重型 UI 框架,卡片/表格手写 CSS。
- 深色主题(CSS 变量);速率数字 `tabular-nums`;文档与界面语言为中文。
- GeoIP 只用本地库文件,**禁止在线查询**(本工具监控别人联网,自己不能偷偷联网,design.md §9)。
- 单人项目:`main` 保持可跑,功能直接提交,无 PR 流程;Phase 验收标准随提交说明,不过验收不进下一 Phase。

## 已知坑

- **本机流量走环回代理 127.0.0.1:7897**:应用事件的 remoteIp 是代理而非真实远端(真实远端在代理进程的事件里)。富化层已实现 transit 识别 + 两跳关联(`apps/collector/src/enrich.ts`,§3.3.1),规则引擎对 transit 进程豁免 new-destination;上层新增消费方不得绕过富化器直接消费原始事件(详见 spike-notes)。
- nethogs 输出格式随版本变化(本机锁定 0.8.7):解析器按列名容错,以 `docs/samples/nethogs.txt` 真实样本为准。
- `unknown-flow`(归因不到进程)是正常事件而非错误,规则引擎对它单独处理(§6),不要静默丢弃;`flow.pid=null`(进程名已知、PID 缺失)与它是两种事件,不得混用。
