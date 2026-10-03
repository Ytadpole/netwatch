# netwatch — 进程级上传监控仪表盘

> 看什么程序在偷偷上传、传给谁、传了多少。
> 形态:本机常驻采集 + Web 仪表盘实时查看 + 异常上传告警。
> **跨平台**:Linux(首发完整支持)、macOS(功能基本对齐)、Windows(降级支持,见 §3.4)。

## 1. 背景与目标

### 要回答的问题

1. **现在谁在传?** 实时:每个进程 → 每个远端地址的上传速率。
2. **它传给谁?** IP → 域名 → 归属地/ASN,一眼判断"该不该传"。
3. **它传了多少?** 按分钟/小时/天滚动的上传量历史,进程排行。
4. **什么在偷偷传?** 行为异常检测:首次出现的目的地、冷门进程的大流量、非白名单进程的外联。

### 非目标(能力边界,明确不做)

- **不做内容审计**:HTTPS 加密内容不可见,也不应该做 MITM。检测靠"行为元数据"(谁、何时、何地、多少)。
- 不做防火墙/拦截(那是 opensnitch 的领域),本工具只**观测和告警**。
- 不做跨主机/集群监控,只监控本机。

### 用户与运行环境

- 单用户:你自己。运行于 Linux/macOS/Windows 桌面,Node ≥ 22。
- 采集需要高权限(Linux root / macOS root / Windows 管理员),Web 展示不需要——权限分离,见 §3。

## 2. 总体架构

```
┌────────────────────────── 采集进程(需 root/sudo)──────────────────────────┐
│                                                                            │
│  TrafficSource 适配器 ──→ 行解析器 ──→ TrafficEvent(类型化事件流)         │
│  (Linux: nethogs; macOS: nettop; Windows: ETW/降级)                        │
│                                                    ▼                        │
│  DNS 观察器 ─────────────────────────────→ 富化器(域名归属)               │
│  (systemd-resolved 日志/53端口旁听)              │                        │
│                                                    ▼                        │
│                                          聚合器(内存滚动窗口)             │
│                                                    │ 定期落盘               │
└────────────────────────────────────────────────────┼────────────────────────┘
                                                     ▼
                                              SQLite(单一数据源)
                                                     ▲
┌────────────────────────── 展示进程(普通用户)────────┴────────────────────┐
│  Hono API:REST 查询 + SSE 实时推送 ──→ React 仪表盘(Vite 构建,静态托管)  │
│  规则引擎:订阅事件流 → 阈值/首见/白名单判定 → 通知(桌面/webhook)         │
└───────────────────────────────────────────────────────────────────────────┘
```

两个独立进程,SQLite 是唯一耦合点——采集崩了不影响看历史,展示重启不丢数据。

## 3. 采集层设计(核心难点)

### 3.1 为什么是 nethogs 起步(Linux 主路径)

Linux 内核不提供「进程 → 上传字节数」的现成账本。nethogs 用 libpcap 抓包 + 匹配 `/proc/*/fd` 的 socket inode 归因到进程,是最成熟的现成方案:

- `nethogs -t -d 2` 以 trace 模式每 2 秒输出:`进程名\tPID\t发送\t接收\t...`(spike 阶段确认精确格式)。
- 我们作为**父进程**启动它(sudo 运行 netwatch 采集端),逐行解析,零额外依赖。
- 已知局限:nethogs 的进程归因在连接关闭后有短暂滞留;短连接可能归因到 UNKNOWN。规则引擎对 UNKNOWN 单独处理(见 §6)。

### 3.2 eBPF 进阶路线(stretch,仅 Linux)

在内核 `tcp_sendmsg` 挂 kprobe,C 写探针 + ring buffer 上报 `(pid, daddr, dport, bytes)`,用户态 Node 侧消费。精确到每个 send 调用,不再依赖抓包。先用 bpftool/bpftrace 手工验证,再决定是否用 Rust 编译探针、TS 通过 Unix socket 消费。**文档阶段不承诺,spike 后补评估。**

### 3.3 DNS 观察(把 IP 翻译成域名)

优先级从高到低:

1. 读取 `systemd-resolved` 的私网查询接口(若可用);
2. 旁听本机 53 端口 DNS 查询(需 root,提取 qname);
3. 兜底:对活跃远端 IP 做反向 DNS + MaxMind GeoLite2 免费库查归属地/ASN。

产出 `ip → { domain?, country?, asn? }` 缓存表,富化器打在事件上。

### 3.4 跨平台采集适配(核心抽象)

采集层的唯一契约是 `TrafficSource`,按 `process.platform` 在启动时选择实现:

```ts
export interface TrafficSource {
  /** 归一化事件流,各平台实现内部各自解决"进程归因" */
  events(): AsyncGenerator<TrafficEvent>;
  /** 声明本平台能力,展示端据此决定显示什么(如 Windows 无字节数只显示连接) */
  readonly capabilities: { perProcessBytes: boolean; dnsObservation: boolean };
}
export function createTrafficSource(): TrafficSource; // linux | darwin | win32 分发
```

| 平台 | 首选数据源 | 进程归因 | 字节数 | 备注 |
| --- | --- | --- | --- | --- |
| **Linux**(首发) | `nethogs -t`(libpcap) | pcap + /proc socket inode | ✅ 准确 | stretch:eBPF kprobe(§3.2) |
| **macOS** | `nettop -P -L 1`(系统自带) | 系统直接给出每进程收发字节 | ✅ 系统计费 | 零依赖输出 JSON,解析比 nethogs 还简单;无需 pcap |
| **Windows** | ETW(`Microsoft-Windows-Kernel-Network`) | 事件自带 PID | ✅ 准确 | 需要管理员 + ETW 消费器(Node 生态不成熟,先用小型 Rust/Go helper 或 `logman` 落 ETL 再解析) |

Windows 降级路径(ETW helper 未就绪时):轮询 `Get-NetTCPConnection` + 进程映射,只有"谁连了谁"没有字节数,`capabilities.perProcessBytes = false`,仪表盘隐藏速率列、告警只跑 `new-destination` 规则。**所有上层(富化/聚合/规则/Web)只消费 `TrafficEvent`,不知道平台差异**——跨平台的全部复杂度被封在 `apps/collector/src/sources/<platform>/` 里。

各平台配套差异(同在 sources 内实现):

- DNS 观察:Linux 走 systemd-resolved/53 端口;macOS 读 mDNSResponder 日志流;Windows 轮询 `Get-DnsClientCache`。拿不到就退回反向 DNS(共同兜底)。
- 桌面通知:notify-send / osascript / Windows Toast(PowerShell 或 node-notifier)。
- 常驻:systemd / launchd / Windows 服务(Winsw 或 schtasks)。
- 打包:直接 `npm i -g` 起步;Phase 5 后评估 `bun compile`/`pkg` 出单文件可执行,免装 Node。

### 3.5 事件模型(TS,采集层的输出契约)

```ts
// 判别联合:解析器只产出这两种
export type TrafficEvent =
  | { kind: "flow"; pid: number | null; process: string; remoteIp: string;
      remotePort: number; sentBytes: number; recvBytes: number; at: number }
  | { kind: "unknown-flow"; remoteIp: string; remotePort: number;
      sentBytes: number; recvBytes: number; at: number };  // 归因不到进程

export type EnrichedFlow = Extract<TrafficEvent, { kind: "flow" }> & {
  domain?: string; country?: string; asn?: string; firstSeen: boolean;
};
```

解析器用 `AsyncGenerator<TrafficEvent>` 输出,聚合器用 `for await` 消费——背压天然成立。

## 4. 数据模型(SQLite)

```sql
-- 每分钟每 (进程 × 远端) 一行,原始事件不落库
-- Phase 2 修订:① 补上主键里引用但漏声明的 remote_port 列;
--   ② pid NOT NULL,flow.pid=null(进程名已知、PID 缺失)存 -1 哨兵——SQLite 主键
--      把 NULL 视为互异,可空 pid 会产生同键重复行;
--   ③ 增列 kind 区分 'flow' 与 'unknown-flow'(归因失败):unknown 行 pid=-1、
--      process='',与 pid=null 的事件是两种东西,不得混用(§6)。
CREATE TABLE flow_minutes (
  minute      INTEGER NOT NULL,  -- Unix 时间戳,整分
  kind        TEXT NOT NULL,     -- 'flow' | 'unknown-flow'
  pid         INTEGER NOT NULL,  -- 未知 PID 存 -1
  process     TEXT NOT NULL,
  remote_ip   TEXT NOT NULL,
  remote_port INTEGER NOT NULL,
  domain      TEXT,              -- 富化,可空(Phase 5)
  country     TEXT,
  asn         TEXT,
  sent        INTEGER NOT NULL,  -- 该分钟上传字节
  recv        INTEGER NOT NULL,
  PRIMARY KEY (minute, kind, pid, process, remote_ip, remote_port)
);

CREATE TABLE destinations (        -- 目的地维表:首见时间用于"新目的地"告警
  remote_ip TEXT PRIMARY KEY,
  domain TEXT, country TEXT, asn TEXT,
  first_seen INTEGER NOT NULL      -- 事件时刻(毫秒),非落盘时刻
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY, at INTEGER,
  rule TEXT,            -- 'new-destination' | 'volume-threshold' | 'unknown-process'
  severity TEXT,        -- 'info' | 'warn' | 'high'
  detail JSON           -- 触发时的快照(进程/目的地/速率/当量)
);
```

库文件默认 `~/.local/share/netwatch/netwatch.db`(XDG),WAL 模式——采集端(root)写、展示端(普通用户)读是两个进程的常态并发,Phase 5 部署时细化文件权限。

查询模式全部围绕 `flow_minutes` 的聚合(最近 N 分钟 Top、按进程日累计、按目的地日累计),数据量:每分钟几十行,一年百万级,SQLite 无压力。

## 5. Web 仪表盘

### 页面(单页应用,三个视图)

1. **实时**:SSE 推送当前活跃流,上传速率条形排行(进程分组,展开看目的地);顶部全局上行/下行速率仪表。
2. **历史**:时间范围选择器(1h/24h/7d),双维度 Top 表(按进程、按目的地),堆叠面积图(按进程的分钟级上传量,Recharts)。
3. **告警**:告警列表 + 规则配置(阈值、白名单管理)。

### API(Hono,复用 flashcards 验证过的模式)

```
GET  /api/live            (SSE)当前活跃流事件流
GET  /api/top/processes?range=1h|24h|7d
GET  /api/top/destinations?range=...
GET  /api/history/series?metric=sent&groupBy=process&range=24h
GET  /api/alerts          POST /api/alerts/rules   (规则 CRUD)
```

类型安全 RPC + zod schema 继续放 `packages/shared`,前端改后端返回类型编译期即报错。

### 进程间实时通道

采集端把滚动窗口快照写到 SQLite(轻量高频);展示端轮询 1s 或监听 SQLite change,再经 SSE 推给浏览器。**采集端不直接开端口**,避免 root 进程暴露网络服务。

### 5.1 界面设计(线框)

**总体**:深色主题(常驻监控场景不刺眼);顶部全局栏常驻;左侧窄导航切换 实时/历史/告警/设置 四个视图;URL 即状态(`?view=history&range=24h` 可直达、可刷新);速率数字一律等宽(`tabular-nums`),单位自适应(KB/s → MB/s → GB/s)。

```
┌────────────────────────────────────────────────────────────────────────┐
│ ● netwatch      ↑ 2.31 MB/s  ↓ 8.02 MB/s          🔔 3   [Linux · 已连接]│  ← 全局栏:
│                                              (数字 + 60s sparkline)      │    总速率+告警入口
├──┬─────────────────────────────────────────────────────────────────────┤
│实│  实时                                                                │
│时│                                                                      │
│历│  ┌─ chrome ─────────────────────────  ↑ 1.2 MB/s ▂▃▅▃▂ ─┐            │
│史│  │  drive.google.com    443  🇺🇸 US  ████████░░  1.1 MB/s│ ← 进程卡片: │
│告│  │  cdn.example.cn      443  🇨🇳 CN  █░░░░░░░░░  0.1 MB/s│   上传速率排行│
│警│  └──────────────────────────────────────────────────────┘            │
│设│  ┌─ nextcloud-sync ──────────────────  ↑ 0.9 MB/s ──────┐            │
│置│  │  192.168.1.10        443  🏠 局域网  ██████████  0.9  │            │
│  │  └──────────────────────────────────────────────────────┘            │
│  │  ┌─ UNKNOWN(归因失败)──────────────  ↑ 0.3 MB/s ───────┐            │
│  │  │  203.0.113.7         443  ❓ 未知   灰色斜体,规则引擎盯它│         │
│  │  └──────────────────────────────────────────────────────┘            │
│  │  …仅列活跃流,SSE 推送,1s 刷新,无流量的进程不出现                   │
└──┴─────────────────────────────────────────────────────────────────────┘
```

设计要点:

- **实时视图**:一张「进程卡片」就是一行主数据——进程名 + 总上传速率 + 60s 迷你走势;展开是目的地明细行:域名(富化)> IP、端口、国家/ASN 徽标、占比条。**新目的地首传 5 分钟内带 `NEW` 徽标**——这是"偷传"最直观的信号。
- **历史视图**:

```
  [1h] [24h] [7d]                              按进程 ▾ / 按目的地 ▾
  ┌────────────────────────────────────────────┐
  │  堆叠面积图:分钟级上传量,每层一个进程      │  ← 点击某层 = 下钻过滤
  └────────────────────────────────────────────┘
  Top 表(列:名称 / 域名·国家 / 总量 / 峰值速率 / 首见时间 / 迷你走势)
```

- **告警视图**:列表(左色条表严重度,内容为快照:进程 → 目的地 → 速率/当量 → 触发规则),未读加粗;下方规则配置卡:三条规则各一行(开关联动阈值输入),白名单表格(进程 × 目的 IP,行内删除)。
- **降级适配**:Windows(无字节数)下速率列替换为"连接数",面积图不可用,自动隐藏对应组件——由接口的 `capabilities` 驱动,不是前端写死判断平台。
- **组件策略**:不引重型 UI 框架;面积图/走势用 Recharts,其余(卡片、条形、表格)手写 CSS,延续严格 TS 风格。深色主题用 CSS 变量,色板:上传=琥珀、下载=蓝、告警红/黄/灰、局域网目的地统一"🏠 局域网"徽标。

## 6. 规则引擎(第一版三条规则)


| 规则 | 定义 | 默认阈值 |
| --- | --- | --- |
| `new-destination` | 已知进程首次向新公网 IP 上传 | info;若同时 > 10MB/min 升 warn |
| `volume-threshold` | 单进程上传量异常 | 100MB/10min 或 500MB/h,可配 |
| `unknown-process` | 归因不到进程的持续外传 | 连续 3 个采样窗口 UNKNOWN 且 > 1MB/min |

白名单:`process × remote_ip` 级(如 `nextcloud` → `192.168.1.10`),命中即静默。通知先走桌面 `notify-send` + webhook(可配企业微信/飞书),告警入库供仪表盘展示。

## 7. 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | Node 22 + TypeScript(strict) | tsconfig 沿用 flashcards 的严格配置 |
| 采集 | nethogs 子进程 + 自研行解析 | eBPF 为 stretch(§3.2) |
| 存储 | SQLite(node:sqlite 起步 → 需要时换 Drizzle) | 单文件、零运维 |
| API | Hono + zValidator + SSE | `@hono/node-server` |
| 前端 | React 19 + Vite + Recharts | 与 API 共享类型(hc<RpcApp>) |
| 通知 | notify-send / webhook | 采集端子进程,复用权限上下文 |
| 部署 | systemd 双 unit(netwatch-collector 需 root,netwatch-web 普通用户) | Phase 5;launchd / Windows 服务见 §3.4 |
| 跨平台 | `TrafficSource` 适配器:linux / darwin / win32 三实现 | 平台复杂度全部封在采集层(§3.4),上层零感知 |

## 8. 里程碑(每阶段有验收标准)

| # | 内容 | 验收 |
| --- | --- | --- |
| 0 | **Spike**:sudo nethogs -t 真实输出采样;确认解析可行性 | 拿到 ≥ 5 分钟真实输出样本,确定格式;**同时定稿 `TrafficSource` 接口** |
| 1 | 采集层:解析器 + AsyncGenerator 事件流 + CLI 实时打印 | 终端能看到"实时谁在传",跑 30 分钟无泄漏 |
| 2 | 聚合 + SQLite 落库 + 查询脚本 | `netwatch-query top 1h` 输出与手工核对一致 |
| 3 | 规则引擎 + 告警通知 | 人为触发(如 curl 大文件上传)收到告警 |
| 4 | Hono API + React 仪表盘(实时/历史/告警三视图) | 浏览器实时刷新,SSE 断线自动重连 |
| 5 | systemd 部署 + 富化完善(GeoIP/ASN/DNS)+ README | 重启后自恢复;仪表盘显示域名与归属地 |
| 6 | stretch:eBPF 精确统计(Linux) | 与 nethogs 数字交叉验证误差 < 5% |
| 7 | **macOS 适配器**:`nettop -P -L` 实现 TrafficSource | 同一事件契约跑通,仪表盘在 macOS 上功能对齐 |
| 8 | **Windows**:ETW helper 评估 → 降级路径(Get-NetTCPConnection 轮询) | `capabilities.perProcessBytes=false` 时仪表盘/告警正确降级 |

## 9. 风险与对策

- **nethogs 输出格式不稳定**(版本差异)→ 解析器按列名容错,spike 阶段锁定本机版本格式;预留 ss/proc 兜底采集器(同一 `Store` 接口)。
- **权限**:sudo 采集端要最小化——采集端只写库,不开网络端口,Web 端普通用户身份。
- **磁盘增长**:flow_minutes 按天汇总后清理 90 天前明细(定时任务,Phase 5)。
- **隐私自悖论**:本工具自己也联网(GeoIP 查询)→ GeoIP 用本地库文件,不做在线查询。
- **跨平台陷阱**:
  - nethogs 仅 Linux → macOS 用 nettop、Windows 用 ETW/降级路径,都实现同一 `TrafficSource`,接口先行(Phase 0 定稿)避免采集逻辑污染上层;
  - macOS `nettop` 对全部进程计费需要 root;Windows ETW 需要管理员且 Node 生态消费器不成熟 → helper 独立成小项目/二进制,失败可退降级路径,不阻塞主线。

## 10. 目录规划(Phase 1 时初始化)

```
netwatch/
├── packages/shared/     # 事件模型、zod schema、聚合类型
├── apps/collector/
│   └── src/sources/     # 平台适配层:linux/ | macos/ | windows/,对外只有 createTrafficSource()
└── apps/web/            # Hono API + React 仪表盘
```

## 11. 功能池(Backlog,主线之外按优先级取用)

### 观测增强(与"抓偷传"强相关,优先)

| 功能 | 说明 | 依赖 |
| --- | --- | --- |
| Beacon/心跳检测 | 定时小包外联(间隔方差小 + 长时间存活)是回传行为的典型特征;在聚合器滚动窗口上做简单统计即可 | 无,规则引擎顺势加第 4 条规则 |
| 纯上行连接标注 | 收发比悬殊(只发不收)的连接打「↑」角标,疑似数据外送 | 富化器顺手算 |
| 目的地画像页 | IP/域名详情:ASN/组织、分类徽标(对象存储/网盘/AI 服务——"谁在往 AI 服务传文件")、历史累计、哪些进程碰过它 | GeoIP + 一张静态分类规则表 |
| 进程画像 | 进程路径、启动时间、Windows 数字签名;路径可疑(临时目录)时告警升级 | /proc(扩展到各平台) |
| 基线异常学习 | 按「进程 × 目的地」学两周规律,偏离日常模式(时段/量级)即异常;简单统计,不上 ML | flow_minutes 攒够两周数据 |
| DNS 全记录 | 记录解析行为本身(含未建立连接的域名),防 DNS 隧道类偷传 | §3.3 的加强版 |
| 本机对外监听告警 | 新开监听端口提示("谁在偷偷接客"),方向相反的一路观测 | ss/netstat 轮询,轻量 |

### 体验增强

- **每日摘要**:昨日上传 Top、新目的地、告警回顾,webhook 定时推送。
- **进程上传配额**:按进程设月度上限(如备份工具 10GB/月),超限告警。
- **隐私模式**:一键遮蔽域名/IP(投屏演示用)。
- **数据导出**:CSV/月度报表。

### 远期(明确缓做)

- **一键处置**(kill/断网):从"只观测"跨到"可干预",权限模型与误杀风险需单独设计。
- **多机模式**:多台机器采集端推送到中心展示端(单一 SQLite → 服务端化),跨平台适配的价值在此放大。
- **eBPF 全量包长统计**(§3.2)落地后可支撑"按连接"粒度的精确画像。
