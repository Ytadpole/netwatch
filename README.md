# netwatch

> 看什么程序在偷偷上传、传给谁、传了多少。

进程级上传监控仪表盘:本机常驻采集 + Web 实时查看 + 异常上传告警。检测靠**行为元数据**(谁、何时、何地、多少)——不做内容审计,不做 MITM,不做拦截,只观测和告警。

**状态:主线 Phase 0~4 代码完成(mock 全链路验证),Phase 5 进行中**;真实采集源(ss 轮询)已端到端验证,剩 root 实机验收。当前可跑的内容见[快速开始](#快速开始)。

## 它回答四个问题

1. **现在谁在传?** 实时:每个进程 → 每个远端地址的上传速率(SSE 推送)。
2. **它传给谁?** IP → 域名 → 归属地/ASN,一眼判断"该不该传"。
3. **它传了多少?** 按分钟/小时/天滚动的上传量历史,进程/目的地双维度排行。
4. **什么在偷偷传?** 行为异常检测:首次出现的目的地、冷门进程的大流量、归因不到进程的持续外传。

## 特性

- **进程级归因**:流量归到具体进程,按"进程 → 目的地"两级展示
- **目的地富化**:反向 DNS + GeoLite2 本地库(离线查询,本工具自己不外联;DNS 观察规划中)
- **持久化与查询**:分钟粒度聚合落 SQLite(WAL),`netwatch-query top 1h|24h|7d` 按进程/目的地回看
- **四条告警规则**:`new-destination`(新目的地)、`volume-threshold`(上传量异常)、`unknown-process`(归因失败外传)、`beacon`(心跳式定时小包外联),白名单静默,桌面通知 + webhook
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
| **Linux** | `ss` 轮询(主路径,Phase 0 采样定稿)+ nethogs 交叉验证 | ✅ 准确 | 首发 |
| macOS | `nettop -P -L`(系统自带) | ✅ 系统计费 | 计划(Phase 7) |
| Windows | ETW / 降级:轮询连接 | 降级路径无字节数 | 计划(Phase 8) |

跨平台复杂度封在采集适配层(单一 `TrafficSource` 契约),上层不感知平台;Windows 降级时仪表盘按 `capabilities` 自动隐藏速率相关组件。

## 快速开始

采集端 CLI 两种模式:mock 数据源(无需 root)体验全链路;真实源为 ss 轮询(需 root)。

```bash
# 安装依赖(npm workspaces:packages/shared + apps/collector)
npm install

# 无 root 体验采集端实时视图(mock 数据源,Ctrl+C 退出)
npm run collector:mock

# 采集端跑过并跨过整分钟后,查询落库数据
npm run query -- top 1h                      # 按进程
npm run query -- top 24h --by=destination    # 按目的地

# 测试(规则引擎与落库)
npm test

# 规则阈值 / 白名单 / 通知走 JSON 配置(--rules=path),缺省用内置默认:
# { "whitelist": [{ "process": "nextcloud-sync", "remoteIp": "192.168.1.10" }],
#   "notify": { "webhookUrl": "https://example/hook" } }

# 全部包严格 TS 校验
npm run typecheck

# Web 仪表盘(展示端,普通用户):构建前端后启动 Hono 服务,浏览器打开 http://127.0.0.1:8787
npm run web:build
npm run web            # 环境变量 NETWATCH_DB 指定库路径,默认 ~/.local/share/netwatch/netwatch.db

# Phase 0 spike:采样 nethogs 真实输出(5.5 分钟,自动装 nethogs、注入测试流量;需 root)
sudo bash docs/samples/run-spike.sh

# 真实采集(Linux 主路径:ss 轮询;采集端需要 root)
# sudo npm run collector
```

仪表盘三视图(实时/历史/告警):实时视图由采集端高频写入的快照经 SSE 推送;告警视图可编辑白名单(进程 × 目的 IP),阈值/通知走 JSON 配置(`NETWATCH_RULES`,缺省 `~/.config/netwatch/rules.json`,采集端收到 SIGHUP 热重载)。

## 部署(systemd 常驻)

单机部署 = 两个服务:**采集端**(root,只写库不开端口)+ **展示端**(普通用户,只读库),通过 `/var/lib/netwatch/` 耦合:SQLite 库(采集端 `UMask=0000` 保证 WAL 文件对展示端可读)+ 规则文件(展示端写白名单)。unit 模板里的 `@占位@` 由安装脚本渲染(仓库路径 / node 路径 / 用户)。

```bash
# 一次性:依赖 + 前端产物(仓库直跑;/opt 安装改 install.sh 里的 REPO_DIR)
npm install && npm run web:build

# 安装并启用(sudo 只在这一步;幂等,更新后重跑即可)
sudo bash deploy/install.sh

# 状态与日志
journalctl -u netwatch-collector -f
journalctl -u netwatch-web -f
```

`enable --now` + `Restart=always`:重启机器后两服务自动恢复(Phase 5 验收项)。数据在 `/var/lib/netwatch/netwatch.db`,规则在 `/var/lib/netwatch/rules.json`。

## 数据

- 数据库:`~/.local/share/netwatch/netwatch.db`(WAL);采集端 root 写、展示端只读;明细默认保留 90 天,采集端每小时自动清理。
- 规则配置:`~/.config/netwatch/rules.json`。
- 域名富化:对本机活跃远端做反向 DNS(普通 DNS 查询),正/负结果缓存 6 小时。

## 文档

- [docs/intro.md](docs/intro.md) — 介绍文档:定位、动机、工作原理、隐私边界与现状
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

netwatch 只记录连接元数据(IP、域名、字节数、时间),不接触任何传输内容;GeoIP/ASN 查询全部使用本地库文件,netwatch 自身不发起在线 GeoIP 查询(域名走本机 DNS 的反向解析兜底)。所有数据存本机单个 SQLite 文件。
