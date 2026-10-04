# Phase 0 Spike 笔记

日期:2026-10-03 · 主机:Linux Mint 22.3(Zena),kernel 7.0.0-31 · Node v22.23.3

## 执行状态

| 项 | 状态 |
| --- | --- |
| nethogs 版本锁定 | 源内候选 **0.8.7-2build2**(apt),未安装——sudo 需密码,由 `run-spike.sh` 首次运行时安装 |
| nethogs 真实输出采样 | ✅ 已执行(2026-10-04,样本 nethogs.txt 2348 行 / ss-sample.txt 6650 行);格式分析见下节,**结论改变了 Linux 主路径**(design.md §3.1 已改:ss 轮询为主) |
| TrafficSource 契约定稿 | ✅ `packages/shared/src/{events,source,index}.ts`,strict typecheck 通过 |

## 契约定稿决策(相对 design.md §3.4/§3.5 的细化)

1. **`sentBytes`/`recvBytes` = 采样窗口内增量**,不是累计也不是速率;速率型数据源(nethogs KB/s)由平台实现换算。`at` = 窗口结束时刻(Unix 毫秒),聚合器据此归分钟桶。
2. **`flow.pid=null` 与 `unknown-flow` 严格区分**:前者"进程名已知、PID 缺失"(进程已退出、连接还在),后者完全归因失败。规则引擎对二者策略不同(§6)。
3. **`TrafficSource` 增加 `stop(): Promise<void>`**(design.md 原型没有生命周期方法):nethogs 是子进程,需要优雅回收;`events()` 约定为单次消费的活流。
4. `TrafficSourceCapabilities` 独立导出:Web 层降级渲染只 import 能力声明,不依赖采集接口。
5. `EnrichedFlow` 用 `FlowEvent & Enrichment & { firstSeen }` 交叉类型;`firstSeen` 由聚合器对照 `destinations` 表计算,解析器不感知。

## ss 轮询兜底:确认可行 ✅

`ss -tinp state established` 实测输出每条 TCP 连接的 `bytes_sent` / `bytes_received`(**累计值**,内核直接给),相邻两拍做差即增量;root 下 `-p` 附带 `pid/process`。

- 优点:零抓包、零 pcap 依赖,天然按连接粒度;root 才能看到他人进程名,root 不是额外负担(采集端本来就要 root)。
- 局限:① UDP 无字节计数(ss 不给);② 两次轮询之间建立又关闭的短连接会漏;③ 计数器是**每连接累计**,连接重建后归零,做差需按 (本地端口, 对端) 五元组跟踪生命周期。
- 结论:作为 nethogs 异常时的兜底采集器(同一 `TrafficSource` 契约,§9)完全成立,样本交叉验证数据由 `ss-sample.txt` 提供。

## DNS 观察路径:本机实测结论

`systemd-resolved` 活跃,stub 监听 `127.0.0.53:53` 与 `127.0.0.54:53`(环回)。按 design.md §3.3 的优先级:

1. **私网查询接口:不可用**。resolved 默认不导出查询日志;开 debug 日志要改全局配置且噪音大,不采用。
2. **旁听 53 端口:可行**(root + pcap 抓 lo)。本机所有查询都经过环回 stub,抓 `lo:53` 即可拿到 qname——与 nethogs 同为 libpcap 路线,实现可复用。
3. **反向 DNS + GeoLite2:可用**。`dig` 在位;GeoLite2 用本地库文件(§9 隐私红线)。

## ⚠️ 意外发现:本机走环回代理(127.0.0.1:7897)

`ss` 实测存在大量 `127.0.0.1:* → 127.0.0.1:7897` 连接(clash/mihomo 类代理)。对 netwatch 的影响:

- **"谁在传"不受影响**:各进程 → 代理的上传仍按进程准确归因;代理进程自身的出网连接归到代理名下。
- **"传给谁"会被遮蔽**:应用事件的 remoteIp 全是 127.0.0.1,真实远端只出现在代理进程的事件里。若不做处理,仪表盘会满屏 127.0.0.1,新目的地告警也会因"代理在连新 IP"而失真。
- **对策(待样本验证后细化,先记方向)**:富化层识别环回远端 + 本机代理监听端口,将代理进程标记为 transit;把"应用 → 代理"与"代理 → 真实远端"两跳在展示层做关联(端口/时间窗启发式)。这会影响 §3.3 富化器与 §6 new-destination 规则的实现,design.md 需补一节。
- Windows/其他用户的机器同样适用:凡系统级代理场景都会出现此形态,值得作为通用问题处理而非本机特例。

## 真实格式分析(0.8.7-2build2,样本 2026-10-04)

### nethogs -t 输出(tab 分隔)

- 数据行(2062 行,3 列):`program/pid/uid\tsent\trecv`——sent/recv 为 **KB/s 速率**;进程名可含 `/`(全路径,如 `/usr/sbin/tailscaled`),所以解析必须从**行首取到最后一个 `/pid/uid` 三段组**,不能按 `/` 简单切分。
- 归因失败行:`unknown TCP/0/0\t...`、`unknown UDP/...`(形态同数据行,program 为 "unknown TCP/UDP")。
- 连接关闭瞬间输出 `Unknown connection: ip:port-ip:port` 行(样本 100 行)——归因滞留的实证,无字节数。
- 头部噪音:`Refreshing:`、空行、`Adding local address: ...`、`Ethernet link detected`、`No PPP or Ethernet link: N`。
- **关键:没有远端地址列**。trace 模式是每进程聚合,拿不到"传给谁"。

### ss -tinp state established(每拍一节)

每条连接两行:套接字行(`Recv-Q Send-Q 本地 对端 users:(("名",pid=N,fd=N), ...)`)+ 信息行(含 `bytes_sent` / `bytes_received` **累计字节**)。root 下全量归属;环回代理两跳形态清晰可见(firefox-bin→127.0.0.1:7897 与 verge-mihomo→公网同拍出现,字节相近)。

### 结论与动作

1. Linux 主路径改为 **ss 轮询**(SsSource):唯一能同时给出 远端+进程+字节数 的零依赖方案;短连接漏拍、UDP 无计数为已知局限。
2. nethogs 降级为交叉验证源;parse.ts 按上述真实格式重写。
3. 受控流量验证:回环 curl/python3 与外网上传在两份样本中均出现,格式结论覆盖真实负载。
