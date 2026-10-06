# media — 介绍材料生产管线

介绍视频与幻灯片不是手工产物,而是脚本化生成的:改文案、换截图、调参数后重跑脚本即可重新出片。本目录存放全部生产资产;**成品在 `docs/`**(视频 `docs/video/netwatch-intro.mp4` + 字幕 `.ass`,幻灯片 `docs/netwatch-intro.pptx` / `.pdf`),文档本体在 `docs/intro.md`(手写,不在本管线内)。

## 目录

```
media/
├── tts/
│   ├── narr.txt          # 八段口播稿(S1~S8,行格式 "S1|文本",与视频分镜编号一致)
│   └── gen-narr.sh       # 旁白生成:edge-tts(走本机 7897 代理),输出 S1~S8.mp3
├── video/
│   ├── build.mjs         # 视频合成:帧序列(ffconcat 真实帧时长)→ 分镜 → 拼接 → 旁白混音 → ASS 字幕烧录
│   └── cards/            # 素材卡五张(片头/富化/架构/片尾/终端开场):HTML 源码(title/enrich/arch/end/term + style.css + gen-term.mjs)+ 渲染好的 PNG(构建直接用 PNG)
├── ppt/
│   ├── ppt.cjs           # 幻灯片构建(pptxgenjs,11 页,配色与产品一致)
│   └── assets/           # PPT 引用的两张真实界面截图
├── demo-rules.json       # 演示规则:volume-threshold 降为 20MB/10min(mock 下几分钟内必触发;拍完即弃,勿入正式配置)
└── webhook-receiver.mjs  # 本地 webhook 接收器(:9999,录制告警推送镜头用)
```

## 前置依赖(一次性)

- Node ≥ 22
- `ffmpeg-static` 与 `pptxgenjs`(npm 包,装在任意前缀即可,路径用环境变量传入,见下)
- edge-tts:系统无 pip,先 `curl get-pip.py | python3 -m venv` 引导(详见历史做法:`python3 -m venv` + `get-pip.py` 装 pip,再 `pip install edge-tts`);**必须走本机代理** `--proxy http://127.0.0.1:7897`,直连会被拒
- LibreOffice(本机已装,导 PDF 用)

## 视频重跑

构建工作区约定为 `$MEDIA_BUILD`(缺省 `/tmp/vidbuild`,**易失,重启即没**),需含:

- `frames/{live,hist,alert}/*.png` + 同目录 `meta*.json`(逐秒截图及每帧时间戳;17MB,**不入库**,采集方法见下)
- `narr/S{1..8}.mp3`(由 `tts/gen-narr.sh` 生成后拷入)

```bash
# 1. 依赖(一次性)
npm i --prefix /tmp/mediadeps ffmpeg-static pptxgenjs

# 2. 旁白(文案改 media/tts/narr.txt 后重跑)
media/tts/gen-narr.sh /tmp/vidbuild/narr
#   注意:字幕文本由 build.mjs 直接读仓库 media/tts/narr.txt(不经工作区副本),
#   mp3 输出到工作区即可;两者天然同源,不会出现音字不一致

# 3. 合成(卡片 PNG 直接读本目录 video/cards/;帧与旁白读 $MEDIA_BUILD)
MEDIA_BUILD=/tmp/vidbuild \
FFMPEG=/tmp/mediadeps/node_modules/ffmpeg-static/ffmpeg \
  node media/video/build.mjs
# → $MEDIA_BUILD/final.mp4,确认后:
cp /tmp/vidbuild/final.mp4 docs/video/netwatch-intro.mp4
```

### 帧采集(浏览器逐秒截图,1fps ≈ 仪表盘原生刷新节奏)

1. 起演示环境(三终端,参数照抄,勿动真实配置):

```bash
node media/webhook-receiver.mjs                                          # 终端 0:webhook 接收端
npm run collector:mock -- --db=/tmp/netwatch-demo.db --rules=$(pwd)/media/demo-rules.json   # 终端 1:采集(root 不需要)
NETWATCH_DB=/tmp/netwatch-demo.db NETWATCH_RULES=$(pwd)/media/demo-rules.json NETWATCH_WEB_PORT=8931 npm run web  # 终端 2:展示
```

2. 先跑 **10 分钟以上**攒数据(历史图有形状、告警有存量);录制中 backup-agent 25% 概率每拍换新 IP,NEW 徽标必有
3. 浏览器开 `http://127.0.0.1:8931/?view=live|history|alerts`(history 的时间范围不进 URL,现场点击),逐秒截图并把每帧时间戳记入 meta json;live 需 52 帧,hist 17 帧(24h→1h→7d→按目的地点击切换),alert 16 帧(含白名单添加→删除)
4. 终端开场帧(段 seg01):真实 CLI 追加流采 33 秒(`npx tsx apps/collector/src/cli.ts --mock --no-clear --no-db --no-rules 1>capture.log 2>/dev/null`)→ `node cards/gen-term.mjs`(解析 tick、ANSI→HTML,内嵌进 term.html)→ 浏览器逐秒截 20 帧
5. 注意:NETWATCH_RULES 必须指向 media/demo-rules.json,否则 Web 会读你真实的 `~/.config/netwatch/rules.json`;拍完停掉三个进程、删演示库

## 幻灯片重跑

```bash
PPTXGENJS=/tmp/mediadeps/node_modules/pptxgenjs node media/ppt/ppt.cjs   # → docs/netwatch-intro.pptx
soffice --headless --convert-to pdf --outdir docs docs/netwatch-intro.pptx
```

## 约定与已知事项

- 口播与画面事实以 `docs/intro.md` 为准;状态口径必须保持"开发中 · Linux 首发 · root 实机验收未完成"
- 素材全部来自 **mock 数据源**(文档保留 IP);域名仅反向 DNS 一例(1e100.net);GeoLite2/国旗徽标未接入,画面中不得出现
- PPT 字体:微软雅黑 + Consolas(观众机器随 Office 自带);视频字幕:Noto Sans CJK SC(本机渲染烧录)
- 旁白音量 `volume=1.5`(曾用 2.0 导致峰值贴 0dBFS,勿回调)
