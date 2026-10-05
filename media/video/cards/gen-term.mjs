// 从 capture.log 生成 term.html:tick 含头行(时钟+全局速率),末尾光标闪烁,1s 轮播
import { readFileSync, writeFileSync } from "node:fs";
const raw = readFileSync("/tmp/vidbuild/frames/term/capture.log", "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ansi = (s) => esc(s)
  .replace(/\x1b\[2m/g, '<span class="dim">')
  .replace(/\x1b\[33m/g, '<span class="amber">')
  .replace(/\x1b\[0m/g, "</span>");
const lines = raw.split("\n").filter((l) =>
  l.trim() && !l.startsWith("> ") && !l.startsWith("(node:") && !l.startsWith("(Use `node"));
const ticks = [];
let cur = null;
for (const l of lines) {
  if (l.includes("netwatch collector (mock) · ")) { cur = [ansi(l)]; ticks.push(cur); continue; }
  if (cur) cur.push(ansi(l));
}
console.error(`ticks: ${ticks.length}, lines/tick: ${ticks.map((t) => t.length).join(",")}`);
const html = `<!doctype html><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
html,body { width:1920px; height:1080px; overflow:hidden; }
body { background:#0B0E14; display:flex; align-items:center; justify-content:center;
  font-family:"Noto Sans Mono CJK SC","Noto Sans Mono",monospace; }
.win { width:1520px; height:860px; background:#0D1117; border:1px solid #232C3F; border-radius:12px;
  box-shadow:0 18px 50px rgba(0,0,0,.5); overflow:hidden; }
.bar { height:46px; background:#12161f; display:flex; align-items:center; gap:9px; padding:0 20px; }
.dot { width:13px; height:13px; border-radius:50%; opacity:.75; }
.bar .t { margin-left:14px; font-size:17px; color:#5a6376; }
pre { padding:26px 34px; font-size:25px; line-height:1.52; color:#E8EAF0; white-space:pre; }
.dim { color:#5a6376; } .amber { color:#F5B04C; }
.cursor { animation: blink 1s step-end infinite; color:#F5B04C; }
@keyframes blink { 50% { opacity:0; } }
</style><div class="win">
<div class="bar">
<div class="dot" style="background:#ff5f56"></div><div class="dot" style="background:#ffbd2e"></div><div class="dot" style="background:#27c93f"></div>
<div class="t">netwatch-collector · --no-clear</div>
</div><pre id="out"></pre></div>
<script>
const ticks = ${JSON.stringify(ticks)};
let i = 0;
const out = document.getElementById("out");
const show = () => { out.innerHTML = ticks[i % ticks.length].join("\\n") + '<span class="cursor">▌</span>'; };
show();
setInterval(() => { i++; show(); }, 1000);
</script>`;
writeFileSync("/home/ytadpole/code/netwatch/media/video/cards/term.html", html);
console.error("term.html regenerated (header line + cursor)");
