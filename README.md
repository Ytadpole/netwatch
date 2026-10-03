# netwatch

> 看什么程序在偷偷上传、传给谁、传了多少。

进程级上传监控仪表盘:本机常驻采集 + Web 实时查看 + 异常上传告警。检测靠**行为元数据**(谁、何时、何地、多少)——不做内容审计,不做 MITM,不做拦截,只观测和告警。

**状态:开发初期(Phase 0)**。设计与计划已完成,代码正在落地,安装与使用命令以实际发布为准;当前可跑的内容见[快速开始](#快速开始)。

## 它回答四个问题

1. **现在谁在传?** 实时:每个进程 → 每个远端地址的上传速率(SSE 推送)。
2. **它传给谁?** IP → 域名 → 归属地/ASN,一眼判断"该不该传"。
3. **它传了多少?** 按分钟/小时/天滚动的上传量历史,进程/目的地双维度排行。
4. **什么在偷偷传?** 行为异常检测:首次出现的目的地、冷门进程的大流量、归因不到进程的持续外传。

## 特性

- **进程级归因**:流量归到具体进程,按"进程 → 目的地"两级展示
- **目的地富化**:DNS 观察 + 反向 DNS + GeoLite2 本地库(离线查询,本工具自己不外联)
- **持久化与查询**:分钟粒度聚合落 SQLite(WAL),`netwatch-query top 1h|24h|7d` 按进程/目的地回看
- **三条告警规则**:`new-destination`(新目的地)、`volume-threshold`(上传量异常)、`unknown-process`(归因失败外传),白名单静默,桌面通知 + webhook
- **Web 仪表盘**:深色主题,实时/历史/告警三视图,URL 即状态,可直接刷新直达
- **权限分离**:采集端(root)只写库不开网络端口;展示端普通用户;SQLite 是两个进程唯一耦合点

## 架构

```
┌─────────────── 采集进程(需 root)───────────────┐
│ TrafficSource 平台适配 ─→ 行解析 ─→ 事件流        │
│ DNS 观察器 ──────────→ 富化器 ─→ 聚合器           │
│ 规则引擎(订阅事件流 → 告警)                      │
└────────────────────────┬────────────────────────┘
                         ▼
                  SQLite(单一数据源)
                         ▲
┌────────────────────────┴────────────────────────┐
│ 展示进程(普通用户):Hono API + SSE + React      │
└─────────────────────────────────────────────────┘
```

## 平台支持

| 平台 | 采集方式 | 每进程字节数 | 状态 |
| --- | --- | --- | --- |
| **Linux** | `nethogs -t`(libpcap) | ✅ 准确 | 首发目标 |
| macOS | `nettop -P -L`(系统自带) | ✅ 系统计费 | 计划(Phase 7) |
| Windows | ETW / 降级:轮询连接 | 降级路径无字节数 | 计划(Phase 8) |

跨平台复杂度封在采集适配层(单一 `TrafficSource` 契约),上层不感知平台;Windows 降级时仪表盘按 `capabilities` 自动隐藏速率相关组件。

## 快速开始

开发初期(Phase 1 进行中):采集端 CLI 可用 mock 数据源体验;真实采集待 Phase 0 样本校准后开放。

```bash
# 安装依赖(npm workspaces:packages/shared + apps/collector)
npm install

# 无 root 体验采集端实时视图(mock 数据源,Ctrl+C 退出)
npm run collector:mock

# 采集端跑过并跨过整分钟后,查询落库数据
npm run query -- top 1h                      # 按进程
npm run query -- top 24h --by=destination    # 按目的地

# 全部包严格 TS 校验
npm run typecheck

# Phase 0 spike:采样 nethogs 真实输出(5.5 分钟,自动装 nethogs、注入测试流量;需 root)
sudo bash docs/samples/run-spike.sh

# 真实采集(spike 完成、nethogs 就绪后;采集端需要 root)
# sudo npm run collector
```

Web 仪表盘将在 Phase 4 落地,届时补充安装与运行说明。

## 文档

- [docs/design.md](docs/design.md) — 设计全文:采集层、数据模型、规则引擎、界面线框、功能池
- [docs/plan.md](docs/plan.md) — 开发计划:Phase 0~8 与验收标准
- [docs/samples/spike-notes.md](docs/samples/spike-notes.md) — spike 笔记:数据源可行性、格式确认、已知坑

## 路线图

| 阶段 | 内容 |
| --- | --- |
| Phase 0 | Spike:nethogs 采样、契约定稿 |
| Phase 1 | 采集层 + CLI 实时打印 |
| Phase 2 | SQLite 落库 + 查询 CLI |
| Phase 3 | 规则引擎 + 告警通知 |
| Phase 4 | Hono API + React 仪表盘 |
| Phase 5 | systemd 常驻 + GeoIP/DNS 富化 |
| Phase 6~8 | eBPF 精确统计 / macOS / Windows 适配 |

## 隐私

netwatch 只记录连接元数据(IP、域名、字节数、时间),不接触任何传输内容;GeoIP/ASN 查询全部使用本地库文件,netwatch 自身不向外发起查询。所有数据存本机单个 SQLite 文件。
