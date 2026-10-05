// netwatch 介绍 PPT — 深色主题,琥珀点母题,真实界面截图
const pptxgen = require(process.env.PPTXGENJS ?? "/tmp/vidbuild/node_modules/pptxgenjs");
const path = require("path");

const BG = "0B0E14", PANEL = "141A26", PANEL2 = "0F141F", BORDER = "232C3F";
const AMBER = "F5B04C", BLUE = "5AA7FF", TEXT = "E8EAF0", MUTED = "8A93A6", FAINT = "39435A";
const CJK = "Microsoft YaHei", MONO = "Consolas";
const W = 13.33, H = 7.5, M = 0.5;

const p = new pptxgen();
p.layout = "LAYOUT_WIDE";
p.author = "netwatch";
p.title = "netwatch — 进程级上传监控仪表盘";

const shadow = () => ({ type: "outer", color: "000000", blur: 8, offset: 3, angle: 90, opacity: 0.35 });

// 页骨架:琥珀点 + 词标 + 眉标 + 页码
function chrome(s, kicker, num) {
  s.background = { color: BG };
  s.addShape(p.shapes.OVAL, { x: M, y: 0.42, w: 0.13, h: 0.13, fill: { color: AMBER } });
  s.addText("netwatch", { x: 0.72, y: 0.3, w: 1.6, h: 0.36, fontFace: MONO, fontSize: 15, bold: true, color: TEXT, margin: 0 });
  s.addText(kicker, { x: 2.4, y: 0.3, w: 8, h: 0.36, fontFace: CJK, fontSize: 13, color: MUTED, charSpacing: 3, margin: 0 });
  s.addText(num, { x: W - 1.3, y: H - 0.52, w: 0.8, h: 0.3, fontFace: MONO, fontSize: 11, color: FAINT, align: "right", margin: 0 });
}
function title(s, t, y = 0.95) {
  s.addText(t, { x: M, y, w: W - 2 * M, h: 0.75, fontFace: CJK, fontSize: 32, bold: true, color: TEXT, margin: 0 });
}
function card(s, x, y, w, h, fill = PANEL) {
  s.addShape(p.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: fill }, line: { color: BORDER, width: 1 }, rectRadius: 0.08, shadow: shadow() });
}

/* ---------- 1 封面 ---------- */
let s = p.addSlide();
s.background = { color: BG };
s.addShape(p.shapes.OVAL, { x: 4.62, y: 2.28, w: 0.3, h: 0.3, fill: { color: AMBER } });
s.addText("netwatch", { x: 5.05, y: 1.82, w: 6.2, h: 1.25, fontFace: MONO, fontSize: 66, bold: true, color: TEXT, margin: 0 });
s.addText("看什么程序在偷偷上传、传给谁、传了多少。", { x: 4.68, y: 3.35, w: 8.1, h: 0.6, fontFace: CJK, fontSize: 22, color: MUTED, charSpacing: 2, margin: 0 });
["进程级归因", "实时仪表盘", "异常告警", "只读元数据"].forEach((t, i) => {
  const x = 4.72 + i * 1.62;
  s.addShape(p.shapes.ROUNDED_RECTANGLE, { x, y: 4.35, w: 1.46, h: 0.46, fill: { color: BG }, line: { color: BORDER, width: 1 }, rectRadius: 0.23 });
  s.addText(t, { x, y: 4.35, w: 1.46, h: 0.46, fontFace: CJK, fontSize: 13, color: MUTED, align: "center", valign: "middle", margin: 0 });
});
s.addText("进程级上传监控仪表盘 · 本机常驻采集 + Web 实时查看", { x: 4.72, y: 5.35, w: 8, h: 0.4, fontFace: CJK, fontSize: 14, color: FAINT, margin: 0 });
s.addText("开发中 · Linux 首发 · 2026-10", { x: M, y: H - 0.62, w: 5, h: 0.34, fontFace: CJK, fontSize: 12, color: FAINT, margin: 0 });
s.addNotes("定位:进程级上传监控仪表盘。只观测行为元数据,不看内容、不拦流量。");

/* ---------- 2 四个问题 ---------- */
s = p.addSlide();
chrome(s, "WHY", "02 / 11");
title(s, "它回答四个问题");
const rows2 = [
  ["01", "现在谁在传?", "实时视图:每个进程 → 每个远端地址的上传速率,SSE 秒级推送"],
  ["02", "它传给谁?", "IP → 域名 → 归属地 / ASN / 服务分类,一眼判断\u201c该不该传\u201d"],
  ["03", "它传了多少?", "分钟粒度聚合落库,1h / 24h / 7d 按进程、目的地双维度回看"],
  ["04", "什么在偷偷传?", "新目的地首传、超阈值大流量、归因失败外传,三条规则自动告警"],
];
rows2.forEach((r, i) => {
  const y = 1.95 + i * 1.28;
  s.addText(r[0], { x: 0.55, y, w: 1.15, h: 0.9, fontFace: MONO, fontSize: 40, bold: true, color: AMBER, margin: 0 });
  s.addText(r[1], { x: 1.95, y: y + 0.06, w: 3.9, h: 0.55, fontFace: CJK, fontSize: 21, bold: true, color: TEXT, margin: 0 });
  s.addText(r[2], { x: 6.05, y: y + 0.12, w: 6.8, h: 0.55, fontFace: CJK, fontSize: 14.5, color: MUTED, margin: 0 });
  if (i < 3) s.addShape(p.shapes.LINE, { x: 1.95, y: y + 1.06, w: 10.9, h: 0, line: { color: BORDER, width: 1 } });
});
s.addNotes("四个问题对应三个视图加一套告警,是全片的章节结构。");

/* ---------- 3 定位:只观测不干预 ---------- */
s = p.addSlide();
chrome(s, "POSITIONING", "03 / 11");
title(s, "只观测,不干预");
s.addText([
  { text: "检测靠行为元数据 —— ", options: { color: TEXT } },
  { text: "谁 · 何时 · 何地 · 多少", options: { color: AMBER } },
], { x: M, y: 1.72, w: 12, h: 0.62, fontFace: CJK, fontSize: 24, bold: true, margin: 0 });
card(s, M, 2.75, 5.95, 3.55);
card(s, 6.9, 2.75, 5.95, 3.55);
s.addText("做", { x: 0.95, y: 3.0, w: 1.2, h: 0.5, fontFace: CJK, fontSize: 20, bold: true, color: AMBER, margin: 0 });
s.addText("不做", { x: 7.35, y: 3.0, w: 1.6, h: 0.5, fontFace: CJK, fontSize: 20, bold: true, color: MUTED, margin: 0 });
[["进程级流量归因", "流量归到「进程 × 目的地」两级"],
 ["目的地富化", "域名 / 归属地 / ASN / 服务分类"],
 ["行为异常告警", "新目的地 · 超阈值 · 归因失败"],
 ["历史回看与查询", "分钟粒度 90 天,CLI 与 Web 双入口"]].forEach((r, i) => {
  const y = 3.62 + i * 0.66;
  s.addShape(p.shapes.OVAL, { x: 0.98, y: y + 0.09, w: 0.09, h: 0.09, fill: { color: AMBER } });
  s.addText([{ text: r[0] + "  ", options: { bold: true, color: TEXT } }, { text: r[1], options: { color: MUTED } }],
    { x: 1.25, y, w: 5.4, h: 0.5, fontFace: CJK, fontSize: 14.5, margin: 0 });
});
["内容审计与 MITM 解密", "防火墙与拦截(opensnitch 的领域)", "跨主机 / 集群监控(只看本机)"].forEach((t, i) => {
  const y = 3.62 + i * 0.66;
  s.addShape(p.shapes.LINE, { x: 7.38, y: y + 0.14, w: 0.18, h: 0, line: { color: FAINT, width: 2 } });
  s.addText(t, { x: 7.68, y, w: 5.0, h: 0.5, fontFace: CJK, fontSize: 14.5, color: MUTED, margin: 0 });
});
s.addText("发现问题的手段是\u201c看得见\u201d,不是\u201c管得住\u201d。", { x: M, y: 6.55, w: 12, h: 0.45, fontFace: CJK, fontSize: 15, color: FAINT, italic: true, margin: 0 });
s.addNotes("能力边界是设计决定:不做 MITM,不做拦截,只做观测与告警。");

/* ---------- 4 实时视图截图 ---------- */
s = p.addSlide();
chrome(s, "LIVE VIEW", "04 / 11");
title(s, "实时视图 · 现在谁在传");
[["进程卡", "每个在传数据的进程一张卡,展开是目的地明细"],
 ["徽标", "局域网 / 本地(代理)/ NEW 首见 / 归因失败,状态一眼可读"],
 ["顶栏", "全局上下行速率 + 未读告警,SSE 秒级推送,断线自动重连"]].forEach((r, i) => {
  const y = 2.0 + i * 1.35;
  s.addText(r[0], { x: M, y, w: 3.9, h: 0.45, fontFace: CJK, fontSize: 17, bold: true, color: AMBER, margin: 0 });
  s.addText(r[1], { x: M, y: y + 0.45, w: 3.9, h: 0.75, fontFace: CJK, fontSize: 13.5, color: MUTED, margin: 0 });
});
s.addImage({ path: path.join(__dirname, "assets", "live-crop.png"), x: 4.75, y: 1.85, w: 8.08, h: 4.545, shadow: shadow() });
s.addText("mock 数据源 · 真实界面(环回代理两跳形态:chrome → 127.0.0.1:7897 → mihomo → 公网)", { x: 4.75, y: 6.55, w: 8.08, h: 0.35, fontFace: CJK, fontSize: 11.5, color: FAINT, margin: 0 });
s.addNotes("截图来自 mock 数据源的真实运行。backup-agent 的 NEW 徽标即新目的地首传。");

/* ---------- 5 架构 ---------- */
s = p.addSlide();
chrome(s, "ARCHITECTURE", "05 / 11");
title(s, "两个进程,一个库");
card(s, 0.55, 1.9, 4.7, 3.6);
s.addText([{ text: "采集进程", options: { bold: true, color: AMBER, fontSize: 19 } }, { text: "  需 root", options: { color: MUTED, fontSize: 13 } }],
  { x: 0.95, y: 2.15, w: 3.9, h: 0.5, fontFace: CJK, margin: 0 });
["ss 轮询 → 行解析 → 事件流", "富化器(域名 / 代理两跳)", "聚合器(分钟桶)→ 落库", "规则引擎 → 桌面 / webhook"].forEach((t, i) => {
  s.addText(t, { x: 0.95, y: 2.8 + i * 0.62, w: 4.0, h: 0.5, fontFace: CJK, fontSize: 14.5, color: TEXT, margin: 0 });
});
card(s, 8.1, 1.9, 4.7, 3.6);
s.addText([{ text: "展示进程", options: { bold: true, color: BLUE, fontSize: 19 } }, { text: "  普通用户", options: { color: MUTED, fontSize: 13 } }],
  { x: 8.5, y: 2.15, w: 3.9, h: 0.5, fontFace: CJK, margin: 0 });
["Hono API(REST + SSE)", "React 仪表盘 · 三视图", "只读打开数据库", "规则配置 · 白名单管理"].forEach((t, i) => {
  s.addText(t, { x: 8.5, y: 2.8 + i * 0.62, w: 4.0, h: 0.5, fontFace: CJK, fontSize: 14.5, color: TEXT, margin: 0 });
});
s.addText("▼", { x: 6.28, y: 2.2, w: 0.8, h: 0.45, fontFace: CJK, fontSize: 17, color: FAINT, align: "center", margin: 0 });
s.addShape(p.shapes.ROUNDED_RECTANGLE, { x: 5.72, y: 2.75, w: 1.9, h: 1.35, fill: { color: "1A2130" }, line: { color: AMBER, width: 1.5 }, rectRadius: 0.08 });
s.addText([{ text: "SQLite\n", options: { bold: true, color: TEXT, fontSize: 20 } }, { text: "WAL · 唯一耦合点", options: { color: MUTED, fontSize: 11.5 } }],
  { x: 5.72, y: 2.75, w: 1.9, h: 1.35, fontFace: CJK, align: "center", valign: "middle", margin: 0 });
s.addText("▲", { x: 6.28, y: 4.2, w: 0.8, h: 0.45, fontFace: CJK, fontSize: 17, color: FAINT, align: "center", margin: 0 });
s.addText([
  { text: "采集端不开任何网络端口", options: { color: MUTED } }, { text: "    ·    ", options: { color: FAINT } },
  { text: "明细保留 90 天自动清理", options: { color: MUTED } }, { text: "    ·    ", options: { color: FAINT } },
  { text: "采集崩了不影响看历史,展示重启不丢数据", options: { color: MUTED } },
], { x: M, y: 6.0, w: 12.3, h: 0.45, fontFace: CJK, fontSize: 14, align: "center", margin: 0 });
s.addNotes("权限分离:root 进程零网络暴露,实时快照走库里的 live_snapshot 行,Web 轮询后经 SSE 推浏览器。");

/* ---------- 6 采集选型 ---------- */
s = p.addSlide();
chrome(s, "COLLECTION", "06 / 11");
title(s, "采集:为什么是 ss 轮询");
[["Phase 0 实证", "nethogs -t 输出的是每进程聚合,没有远端地址列 —— 撑不起\u201c传给谁\u201d,原方案被真实样本推翻"],
 ["ss 的答案", "每条连接自带远端地址、进程归属和累计字节;相邻两拍做差即增量,零抓包、零 pcap 依赖"],
 ["nethogs 没有缺席", "降级为交叉验证 / 无目的地降级源,与 ss 同一 TrafficSource 契约"]].forEach((r, i) => {
  const y = 2.0 + i * 1.42;
  s.addText(r[0], { x: M, y, w: 5.6, h: 0.45, fontFace: CJK, fontSize: 17, bold: true, color: AMBER, margin: 0 });
  s.addText(r[1], { x: M, y: y + 0.46, w: 5.6, h: 0.85, fontFace: CJK, fontSize: 13.5, color: MUTED, margin: 0 });
});
card(s, 6.7, 1.9, 6.1, 2.62, PANEL2);
s.addText([
  { text: "$ ss -tinp state established\n", options: { color: AMBER } },
  { text: "Peer Address:Port   104.20.23.154:443\n", options: { color: TEXT } },
  { text: "users:((\"mihomo\",pid=777,fd=48))\n", options: { color: TEXT } },
  { text: "bytes_sent:2097152  bytes_received:838860\n", options: { color: BLUE } },
], { x: 7.05, y: 2.18, w: 5.5, h: 1.75, fontFace: MONO, fontSize: 14, lineSpacingMultiple: 1.4, valign: "top", margin: 0 });
s.addText("真实输出字段(节选):远端地址 + 进程归属 + 每连接累计字节", { x: 6.7, y: 4.78, w: 6.1, h: 0.4, fontFace: CJK, fontSize: 12, color: MUTED, margin: 0 });
s.addText([{ text: "已知局限:", options: { bold: true, color: TEXT } }, { text: "两次轮询之间建立又关闭的短连接会漏;UDP 无字节计数 —— eBPF 精确统计为后续进阶路线", options: { color: MUTED } }],
  { x: M, y: 6.35, w: 12.3, h: 0.5, fontFace: CJK, fontSize: 13.5, margin: 0 });
s.addNotes("选型依据是 Phase 0 的 5.5 分钟真实采样(2348 行 nethogs + 6650 行 ss)。");

/* ---------- 7 富化 ---------- */
s = p.addSlide();
chrome(s, "ENRICHMENT", "07 / 11");
title(s, "富化:把 IP 翻译成人话");
[["反向 DNS", "已实现", "108.177.10.99 → oy-in-f99.1e100.net(本机发起,正/负缓存 6h)", true],
 ["分类规则表", "已实现", "静态后缀匹配:AI 服务 / 网盘 / 对象存储徽标 —— \u201c谁在往 AI 服务传文件\u201d一眼可见", false],
 ["GeoLite2 归属地 / ASN", "接入中", "只用本地库文件,netwatch 自己不做在线查询", false]].forEach((r, i) => {
  const y = 1.95 + i * 1.42;
  card(s, M, y, 6.5, 1.22);
  s.addText([{ text: r[0] + "   ", options: { bold: true, color: TEXT, fontSize: 16 } }, { text: r[1], options: { color: r[1] === "已实现" ? AMBER : FAINT, fontSize: 12 } }],
    { x: 0.9, y: y + 0.16, w: 5.8, h: 0.42, fontFace: CJK, margin: 0 });
  s.addText(r[2], { x: 0.9, y: y + 0.6, w: 5.75, h: 0.55, fontFace: r[3] ? MONO : CJK, fontSize: r[3] ? 13 : 12.5, color: MUTED, margin: 0 });
});
s.addText("环回代理两跳:告警归因不被代理污染", { x: 7.45, y: 1.98, w: 5.4, h: 0.45, fontFace: CJK, fontSize: 16, bold: true, color: TEXT, margin: 0 });
const nodes = [["应用进程", "chrome"], ["本地代理", "mihomo · 127.0.0.1:7897"], ["真实远端", "104.20.23.154"]];
nodes.forEach((n, i) => {
  const x = 7.45 + i * 1.98;
  s.addShape(p.shapes.ROUNDED_RECTANGLE, { x, y: 2.6, w: 1.62, h: 0.95, fill: { color: i === 1 ? "1A2130" : PANEL }, line: { color: i === 1 ? AMBER : BORDER, width: i === 1 ? 1.5 : 1 }, rectRadius: 0.08 });
  s.addText([{ text: n[0] + "\n", options: { color: MUTED, fontSize: 10.5 } }, { text: n[1], options: { color: TEXT, fontSize: 11.5, bold: true } }],
    { x, y: 2.6, w: 1.62, h: 0.95, fontFace: CJK, align: "center", valign: "middle", margin: 0 });
  if (i < 2) s.addText("▶", { x: x + 1.6, y: 2.92, w: 0.4, h: 0.35, fontFace: CJK, fontSize: 12, color: FAINT, align: "center", margin: 0 });
});
s.addText("应用的 remoteIp 是代理而非真实远端;富化器按字节相关启发式(±25% / ±5s)把两跳关联,transit 代理进程豁免新目的地告警。", { x: 7.45, y: 3.85, w: 5.35, h: 1.0, fontFace: CJK, fontSize: 12.5, color: MUTED, margin: 0 });
s.addText([{ text: "关联只影响展示与告警标注,", options: { color: MUTED } }, { text: "不改变底层归因事实。", options: { bold: true, color: TEXT } }],
  { x: 7.45, y: 4.95, w: 5.35, h: 0.5, fontFace: CJK, fontSize: 12.5, margin: 0 });
s.addNotes("两跳关联是本机走 clash/mihomo 类代理时的正确性关键,Phase 5 已实现并有测试。");

/* ---------- 8 规则引擎 ---------- */
s = p.addSlide();
chrome(s, "RULES", "08 / 11");
title(s, "三条规则,盯住\u201c偷偷传\u201d");
const tbl = [
  [{ text: "规则", options: { bold: true, color: TEXT, fill: { color: PANEL2 } } }, { text: "触发条件(默认,可配)", options: { bold: true, color: TEXT, fill: { color: PANEL2 } } }],
  [{ text: "new-destination", options: { color: AMBER, fontFace: MONO, fontSize: 12.5 } }, { text: "已知进程首次向新公网 IP 上传;当分钟 > 10MB 升 warn", options: { color: TEXT } }],
  [{ text: "volume-threshold", options: { color: AMBER, fontFace: MONO, fontSize: 12.5 } }, { text: "单进程 100MB/10min 或 500MB/h", options: { color: TEXT } }],
  [{ text: "unknown-process", options: { color: AMBER, fontFace: MONO, fontSize: 12.5 } }, { text: "归因不到进程的持续外传:连续 3 窗口且 > 1MB/min", options: { color: TEXT } }],
];
s.addTable(tbl, { x: M, y: 2.0, w: 6.1, colW: [2.0, 4.1], border: { pt: 1, color: BORDER }, fill: { color: PANEL }, fontFace: CJK, fontSize: 13, rowH: 0.62, valign: "middle", margin: 0.08 });
s.addText([{ text: "白名单", options: { bold: true, color: TEXT } }, { text: "  进程 × 目的 IP 命中即静默(支持 * 进程级);已确认的代理中转进程豁免 new-destination", options: { color: MUTED } }],
  { x: M, y: 5.05, w: 6.1, h: 0.8, fontFace: CJK, fontSize: 13, margin: 0 });
s.addText([{ text: "通知", options: { bold: true, color: TEXT } }, { text: "  桌面 notify-send + webhook,告警入库供仪表盘展示;通知失败静默,不影响采集", options: { color: MUTED } }],
  { x: M, y: 5.85, w: 6.1, h: 0.8, fontFace: CJK, fontSize: 13, margin: 0 });
s.addImage({ path: path.join(__dirname, "assets", "alert-f0002.png"), x: 7.0, y: 1.9, w: 5.83, h: 3.28, shadow: shadow() });
s.addText("演示运行 35 分钟(mock 数据源):56 条告警,三条规则全部命中", { x: 7.0, y: 5.35, w: 5.83, h: 0.4, fontFace: CJK, fontSize: 11.5, color: FAINT, margin: 0 });
s.addNotes("阈值走 JSON 配置(~/.config/netwatch/rules.json),Web 端写、采集端读,SIGHUP 热重载。");

/* ---------- 9 数据与隐私 ---------- */
s = p.addSlide();
chrome(s, "PRIVACY", "09 / 11");
title(s, "数据与隐私");
s.addText([{ text: "所有数据", options: { color: TEXT } }, { text: "不出这台机器", options: { color: AMBER } }],
  { x: M, y: 1.85, w: 12, h: 0.8, fontFace: CJK, fontSize: 34, bold: true, margin: 0 });
[["只记录元数据", "IP、端口、域名、字节数、时间 —— 不接触任何传输内容,不做 MITM"],
 ["GeoIP 全部本地库", "本工具监控别人联网,自己不能偷偷联网:归属地 / ASN 走本地文件,域名走本机 DNS 反向解析"],
 ["单个 SQLite 文件", "明细保留 90 天,采集端每小时自动清理;规则配置与数据库都是本机普通文件"]].forEach((r, i) => {
  const y = 3.1 + i * 1.06;
  s.addShape(p.shapes.OVAL, { x: 0.55, y: y + 0.08, w: 0.11, h: 0.11, fill: { color: AMBER } });
  s.addText([{ text: r[0] + "    ", options: { bold: true, color: TEXT, fontSize: 16.5 } }, { text: r[1], options: { color: MUTED, fontSize: 14 } }],
    { x: 0.95, y, w: 11.8, h: 0.75, fontFace: CJK, margin: 0 });
});
card(s, M, 6.25, 12.33, 0.72, PANEL2);
s.addText([
  { text: "数据库  ", options: { color: MUTED } }, { text: "~/.local/share/netwatch/netwatch.db", options: { color: BLUE, fontFace: MONO } },
  { text: "      规则  ", options: { color: MUTED } }, { text: "~/.config/netwatch/rules.json", options: { color: BLUE, fontFace: MONO } },
], { x: 0.9, y: 6.25, w: 11.6, h: 0.72, fontFace: CJK, fontSize: 13, valign: "middle", margin: 0 });
s.addNotes("隐私自洽是硬红线:GeoIP 禁止在线查询(design.md §9)。");

/* ---------- 10 平台与状态 ---------- */
s = p.addSlide();
chrome(s, "ROADMAP", "10 / 11");
title(s, "平台支持与当前状态");
[["Linux", "ss 轮询主路径 + nethogs 交叉验证,eBPF 为后续进阶", "首发", AMBER],
 ["macOS", "nettop -P -L(系统自带,零依赖)", "Phase 7", MUTED],
 ["Windows", "ETW;降级为连接轮询(无字节数)", "Phase 8", MUTED]].forEach((r, i) => {
  const y = 2.0 + i * 1.35;
  s.addText(r[0], { x: M, y, w: 2.2, h: 0.5, fontFace: CJK, fontSize: 19, bold: true, color: TEXT, margin: 0 });
  s.addShape(p.shapes.ROUNDED_RECTANGLE, { x: 2.6, y: y + 0.02, w: 1.15, h: 0.4, fill: { color: BG }, line: { color: r[3], width: 1 }, rectRadius: 0.2 });
  s.addText(r[2], { x: 2.6, y: y + 0.02, w: 1.15, h: 0.4, fontFace: CJK, fontSize: 12, color: r[3], align: "center", valign: "middle", margin: 0 });
  s.addText(r[1], { x: M, y: y + 0.52, w: 5.6, h: 0.6, fontFace: CJK, fontSize: 13.5, color: MUTED, margin: 0 });
});
s.addText("平台差异全部封在采集适配层(单一 TrafficSource 契约),上层零感知;降级由 capabilities 声明驱动。", { x: M, y: 6.1, w: 5.9, h: 0.9, fontFace: CJK, fontSize: 12.5, color: FAINT, margin: 0 });
s.addText("当前状态", { x: 7.0, y: 1.95, w: 5.8, h: 0.5, fontFace: CJK, fontSize: 18, bold: true, color: TEXT, margin: 0 });
[["✓", "Phase 0~4:采集 → 落库 → 查询 → 规则 → 仪表盘,mock 全链路验证", AMBER],
 ["✓", "真实采集源(ss 轮询)端到端验证;nethogs 解析器按 0.8.7 校准", AMBER],
 ["◐", "Phase 5 进行中:两跳富化 · 反向 DNS · 90 天清理 · systemd unit", BLUE],
 ["□", "待办:GeoLite2 接入 · DNS 观察 · root 实机验收(30 分钟稳定性)", MUTED]].forEach((r, i) => {
  const y = 2.55 + i * 0.92;
  s.addText(r[0], { x: 7.0, y, w: 0.45, h: 0.5, fontFace: CJK, fontSize: 17, bold: true, color: r[2], margin: 0 });
  s.addText(r[1], { x: 7.55, y: y + 0.02, w: 5.3, h: 0.75, fontFace: CJK, fontSize: 13, color: r[2] === MUTED ? MUTED : TEXT, margin: 0 });
});
s.addNotes("诚实口径:开发中项目,root 实机验收未完成。macOS / Windows 是计划而非承诺。");

/* ---------- 11 快速体验 ---------- */
s = p.addSlide();
chrome(s, "QUICK START", "11 / 11");
title(s, "快速体验");
card(s, M, 1.95, 12.33, 3.35, PANEL2);
s.addText([
  { text: "npm install\n", options: { color: TEXT } },
  { text: "npm run collector:mock", options: { color: AMBER } }, { text: "            # 无 root 体验全链路(mock 数据源)\n", options: { color: MUTED } },
  { text: "npm run web:build && npm run web", options: { color: AMBER } }, { text: "  # 仪表盘 http://127.0.0.1:8787\n", options: { color: MUTED } },
  { text: "npm run query -- top 24h --by=destination\n", options: { color: AMBER } },
  { text: "sudo npm run collector", options: { color: AMBER } }, { text: "             # 真实采集(Linux 主路径:ss 轮询,需 root)", options: { color: MUTED } },
], { x: 0.95, y: 2.28, w: 11.5, h: 2.7, fontFace: MONO, fontSize: 16, lineSpacingMultiple: 1.55, valign: "top", margin: 0 });
s.addText([
  { text: "文档  ", options: { color: MUTED } }, { text: "docs/intro.md · docs/design.md · docs/plan.md", options: { color: BLUE, fontFace: MONO } },
  { text: "      部署  ", options: { color: MUTED } }, { text: "deploy/*.service(systemd 双 unit)", options: { color: BLUE, fontFace: MONO } },
], { x: M, y: 6.35, w: 12.3, h: 0.45, fontFace: CJK, fontSize: 13, margin: 0 });
s.addNotes("收尾:mock 体验无需 root;真实采集需要 root。项目地址见 README。");

p.writeFile({ fileName: process.env.OUT ?? "/home/ytadpole/code/netwatch/docs/netwatch-intro.pptx" }).then(() => console.log("PPTX written"));
