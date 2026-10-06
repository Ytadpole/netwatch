// netwatch 介绍视频合成:帧序列(ffconcat,真实帧时长)→ 分镜 mp4 → 拼接 → 旁白混音 + ASS 字幕烧录
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const FFMPEG = process.env.FFMPEG ?? "/tmp/vbuild/node_modules/ffmpeg-static/ffmpeg";
const ROOT = process.env.MEDIA_BUILD ?? "/tmp/vidbuild";          // 工作区:frames/ + narr/(体积大,不入库,见 media/README.md)
const CARDS = process.env.CARDS_DIR ?? new URL("./cards/", import.meta.url).pathname; // 卡片渲染图,随仓库走
const OUT = `${ROOT}/scenes`;
mkdirSync(OUT, { recursive: true });

const run = (args, label) => {
  execFileSync(FFMPEG, ["-hide_banner", "-nostats", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  console.log("done:", label);
};
const dur = (file) => {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
  const m = r.stderr.toString().match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
};

// ---------- 帧元数据 ----------
const liveMeta = [...JSON.parse(readFileSync(`${ROOT}/frames/live/meta-a.json`)), ...JSON.parse(readFileSync(`${ROOT}/frames/live/meta-b.json`))];
const histMeta = JSON.parse(readFileSync(`${ROOT}/frames/hist/meta.json`));
const alertMeta = JSON.parse(readFileSync(`${ROOT}/frames/alert/meta.json`));
const termMeta = JSON.parse(readFileSync(`${ROOT}/frames/term/meta.json`));
const toDur = (meta) => meta.map((m, i) => ({ file: `${ROOT}/frames/${m.name && ""}` , t0: m.t0, name: m.name }));
function frameDurs(meta) {
  return meta.map((m, i) => ({
    name: m.name,
    dur: i < meta.length - 1 ? (meta[i + 1].t0 - m.t0) / 1000 : (meta[i].t0 - meta[i - 1].t0) / 1000,
  }));
}
const live = frameDurs(liveMeta).map((f) => ({ ...f, path: `${ROOT}/frames/live/${f.name}` }));
const hist = frameDurs(histMeta).map((f) => ({ ...f, path: `${ROOT}/frames/hist/${f.name}` }));
const alert = frameDurs(alertMeta).map((f) => ({ ...f, path: `${ROOT}/frames/alert/${f.name}` }));
const term = frameDurs(termMeta).map((f) => ({ ...f, path: `${ROOT}/frames/term/${f.name}` }));

// ---------- 旁白 ----------
// 口播文本固定读仓库 media/tts/narr.txt(与 gen-narr.sh 同源,避免工作区副本分叉导致音字不一致)
const NARR_TXT = process.env.NARR_TXT ?? new URL("../tts/narr.txt", import.meta.url).pathname;
const narrText = Object.fromEntries(
  readFileSync(NARR_TXT, "utf8").trim().split("\n").map((l) => {
    const [id, ...rest] = l.split("|");
    return [id, rest.join("|")];
  })
);
const narrDur = {};
for (const id of Object.keys(narrText)) narrDur[id] = dur(`${ROOT}/narr/${id}.mp3`);
console.log("narr durations:", narrDur);

// ---------- 分镜定义 ----------
// type frames: 取 frames 数组中从 fromIndex 起的帧,不足 target 则延长最后一帧
const CROP_LIVE = "crop=1124:632:20:52,scale=1920:1080:flags=lanczos";
const CROP_ALERT = "crop=1456:818:100:55,scale=1920:1080:flags=lanczos";
const CROP_DEST = "crop=960:540:950:470,scale=1920:1080:flags=lanczos";

const scenes = [
  { id: "seg01", src: "term", from: 0, count: 18, filter: null, target: narrDur.S1 + 1.4 },
  { id: "seg02a", card: "title", target: 5.0 },
  { id: "seg02b", src: "live", from: 18, count: 13, filter: null, target: narrDur.S2 + 1.4 - 5.0 },
  { id: "seg03", src: "live", from: 31, count: 17, filter: CROP_LIVE, target: narrDur.S3 + 1.4 },
  { id: "seg04a", src: "hist", from: 13, count: 4, filter: CROP_DEST, target: 8.0 },
  { id: "seg04b", card: "enrich", target: narrDur.S4 + 1.4 - 8.0 },
  { id: "seg05", src: "hist", from: 0, count: 12, filter: null, target: narrDur.S5 + 1.4 },
  { id: "seg06a", src: "alert", from: 0, count: 6, filter: CROP_ALERT, target: 8.0 },
  { id: "seg06b", src: "alert", from: 6, count: 5, filter: null, target: 6.0 },
  { id: "seg06c", src: "alert", from: 11, count: 5, filter: null, target: narrDur.S6 + 1.4 - 14.0 },
  { id: "seg07", card: "arch", target: narrDur.S7 + 1.4 },
  { id: "seg08", card: "end", target: narrDur.S8 + 2.0, fadeOut: true },
];

// ---------- 生成每个分镜 ----------
const starts = [];
let t = 0;
for (const sc of scenes) {
  starts.push(t);
  if (sc.card) {
    const d = sc.target.toFixed(3);
    const frames = Math.round(sc.target * 30);
    const vf = [
      "scale=3840:2160:flags=lanczos",
      `zoompan=z='1+0.05*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=30`,
      "format=yuv420p",
    ].join(",");
    run(["-y", "-i", `${CARDS}card-${sc.card}.png`, "-vf", vf, "-t", d, "-r", "30",
      "-c:v", "libx264", "-preset", "medium", "-crf", "19", `${OUT}/${sc.id}.mp4`], sc.id);
  } else {
    const pool = sc.src === "live" ? live : sc.src === "hist" ? hist : sc.src === "term" ? term : alert;
    const frames = pool.slice(sc.from, sc.from + sc.count);
    let sum = frames.reduce((s, f) => s + f.dur, 0);
    if (sum < sc.target) frames[frames.length - 1].dur += sc.target - sum;
    const lines = ["ffconcat version 1.0"];
    for (const f of frames) lines.push(`file '${f.path}'`, `duration ${f.dur.toFixed(3)}`);
    lines.push(`file '${frames[frames.length - 1].path}'`);
    writeFileSync(`${OUT}/${sc.id}.ffconcat`, lines.join("\n"));
    const vf = ["fps=30", sc.filter, "format=yuv420p"].filter(Boolean).join(",");
    run(["-y", "-f", "concat", "-safe", "0", "-i", `${OUT}/${sc.id}.ffconcat`, "-vf", vf,
      "-t", sc.target.toFixed(3), "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "19",
      `${OUT}/${sc.id}.mp4`], sc.id);
  }
  t += sc.target;
}
const TOTAL = t;
console.log("total duration:", TOTAL.toFixed(2));

// ---------- 拼接 ----------
const list = scenes.map((sc) => `file '${OUT}/${sc.id}.mp4'`).join("\n");
writeFileSync(`${OUT}/join.txt`, list);
run(["-y", "-f", "concat", "-safe", "0", "-i", `${OUT}/join.txt`, "-c", "copy", `${OUT}/joined.mp4`], "joined");

// ---------- 字幕(按标点切句,时长按字数分配) ----------
function splitCues(text) {
  const parts = text.split(/(?<=[。!?;—])/).flatMap((s) => {
    if ([...s].length <= 30) return [s];
    const out = [];
    let cur = "";
    for (const ch of s) {
      cur += ch;
      if ([...cur].length >= 24 && /[,,、:]/.test(ch)) { out.push(cur); cur = ""; }
    }
    if (cur) out.push(cur);
    return out;
  }).filter((s) => s.trim());
  return parts;
}
const assTime = (s) => {
  const h = String(Math.floor(s / 3600)).padStart(1, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${h}:${m}:${sec}`;
};
const narrOf = (idx) => ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"][idx];
const narrStart = {
  S1: starts[0] + 0.3, S2: starts[1], S3: starts[3], S4: starts[4],
  S5: starts[6], S6: starts[7], S7: starts[10], S8: starts[11],
};
let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Noto Sans CJK SC,52,&H00F2F2F2,&H00FFFFFF,&H96101014,&H78000000,0,0,0,0,100,100,0,0,1,2,1,2,80,80,52,1
Style: Chap,Noto Sans CJK SC,34,&H004CB0F5,&H00FFFFFF,&H96101014,&H78000000,1,0,0,0,100,100,0,0,1,2,1,7,60,60,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
for (let k = 0; k < 8; k++) {
  const id = narrOf(k);
  const cues = splitCues(narrText[id]);
  const totalChars = cues.reduce((s, c) => s + [...c].length, 0);
  let cur = narrStart[id];
  for (const c of cues) {
    const d = ([...c].length / totalChars) * narrDur[id];
    ass += `Dialogue: 0,${assTime(cur)},${assTime(cur + d + 0.25)},Sub,,0,0,0,,{\\fad(140,140)}${c.trim()}\n`;
    cur += d;
  }
}
const chapters = [
  [starts[3], starts[4], "Q1 · 现在谁在传?"],
  [starts[4], starts[6], "Q2 · 传给谁?"],
  [starts[6], starts[7], "Q3 · 传了多少?"],
  [starts[7], starts[10], "Q4 · 什么在偷偷传?"],
  [starts[10], starts[11], "工作原理"],
];
for (const [a, b, text] of chapters) {
  ass += `Dialogue: 1,${assTime(a + 0.2)},${assTime(b - 0.2)},Chap,,0,0,0,,${text}\n`;
}
writeFileSync(`${ROOT}/subs.ass`, ass);
console.log("subs written");

// ---------- 混音 + 烧字幕 + 成片 ----------
const narrInputs = [];
for (let k = 0; k < 8; k++) narrInputs.push("-i", `${ROOT}/narr/S${k + 1}.mp3`);
const fc = [];
for (let k = 0; k < 8; k++) {
  const ms = Math.round(narrStart[`S${k + 1}`] * 1000);
  fc.push(`[${k + 1}:a]adelay=${ms}:all=1,volume=1.5[a${k}]`);
}
  fc.push(`${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `[a${k}]`).join("")}amix=inputs=8:normalize=0,alimiter=limit=0.9:level=disabled,apad[aout]`);
const fadeOutStart = (TOTAL - 0.9).toFixed(2);
run(["-y", "-i", `${OUT}/joined.mp4`, ...narrInputs,
  "-filter_complex", fc.join(";"),
  "-map", "0:v", "-map", "[aout]",
  "-vf", `ass=${ROOT}/subs.ass,fade=t=in:st=0:d=0.6,fade=t=out:st=${fadeOutStart}:d=0.9`,
  "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", "30",
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
  "-t", TOTAL.toFixed(3), `${ROOT}/final.mp4`], "final");
console.log("FINAL:", `${ROOT}/final.mp4`, "duration:", dur(`${ROOT}/final.mp4`).toFixed(2));
