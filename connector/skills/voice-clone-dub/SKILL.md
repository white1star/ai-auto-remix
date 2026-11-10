---
name: voice-clone-dub
description: 参考视频音色克隆配音（口播广告换文案）。当用户给出「一个参考视频链接/文件 + 一段新文案」，要求"用这个人的声音念这段文案"、"照这条片子的音色配音"、"把文案换成我们的但声音不变"、"分离出人声和伴奏再配上新词"时使用。产出同音色的配音 wav + 从原片分离的 BGM，逐段转写质检，丢字自动重渲。不适用于：需要原片原声逐字复用的场景（那要剪原音轨，不是克隆）、纯字幕翻译、需要真人录音的正式配音。
agent_created: true
---

# 参考视频音色克隆配音（voice-clone-dub）

给一条参考视频 + 一段新文案，产出「同一个人的声音」念这段新文案的配音，外加从原片分离的 BGM。

一句话：**音色来自原片，字来自你的文案。**

## 何时使用

- 用户给参考视频（抖音/视频号链接或本地文件）+ 新文案，要同音色口播
- 要按原片的伴奏做 BGM
- 批量出同一个人声音的多条口播

不适用：要原片原声逐字复用（应该剪原音轨）、需要真人录音的正式场合。

## 前置

```bash
node scripts/dub.mjs --doctor
```

六项全绿才能跑：F5 权重、音色目录、默认音色、FFmpeg、Python3.12（torch）、Python3.13（faster-whisper）。

### 装在哪、依赖从哪来

技能随项目包交付，位置是 `<包根>/connector/skills/voice-clone-dub/`。脚本会**从自己所在目录向上逐级找** `runtime/ffmpeg.exe` 和 `weights/f5`，所以放在包里就能直接用，不用配环境变量。

| 依赖 | 放哪 / 怎么来 |
|---|---|
| FFmpeg | 包根 `runtime/ffmpeg.exe`，已随包带，自动找到 |
| F5 权重（1.3GB） | 包根 `weights/f5/`（含 `model_1250000.safetensors` + `vocab.txt` + `vocos/`）；或设 `F5_HOME` 指向已有目录 |
| Python 3.12 | 需 `pip install torch torchaudio f5-tts`，用 `PY312` 环境变量指定解释器 |
| Python 3.13 | 需 `pip install faster-whisper pypinyin`，用 `PY313` 指定 |
| 音色档案 | 默认 `~/.workbuddy/voices/`，可用 `VOICES_HOME` 改 |

权重体积大不进包，第一次用要先放好。缺 Python 依赖时 `--doctor` 会直接指出来，别硬跑。

## 用法

```bash
# 新参考视频：建音色档案 + 配音（第一次约多花 2 分钟下载分离）
node scripts/dub.mjs "https://v.douyin.com/xxxx/" 文案.txt --speed 1.2

# 已有默认音色：直接换文案
node scripts/dub.mjs - 文案.txt --speed 1.2

# 指定某个音色档案
node scripts/dub.mjs - 文案.txt --voice a8e15ad9c47a

node scripts/dub.mjs --voices            # 列所有音色
node scripts/dub.mjs --set-default <key> # 改默认音色
```

产出：`out/<时间戳>/配音.wav`（44.1k 单声道）、`伴奏.mp3`、`qc.json`（每段覆盖率），并自动拷一份到桌面。

## 在网站里用（本项目主用法：网站自己合成，不连 WorkBuddy）

网站（AI 自动混剪，`127.0.0.1:8765`）的「配音音色」下拉会列出本机所有音色档案。
选中一个克隆音色点「生成视频」，**服务端 `server/clone.mjs` 直接调本技能的脚本出声**，
没有派单、没有令牌、没有回填，关掉网页也不影响已经在跑的任务。

所以本技能在项目里的唯一职责是**建音色档案**：

```bash
# 建档案（顺带念一遍测试文案）
node scripts/dub.mjs "参考视频链接或本地mp4" 测试文案.txt --speed 1.0
node scripts/dub.mjs --voices            # 建完在这里能看见
node scripts/dub.mjs --set-default <key> # 换成网页默认选中的那项
```

档案落在 `~/.workbuddy/voices/<key>/`，网页刷新即出现；拷给别人就是整个文件夹拷过去。
合成时长按段累计（274 字约 12 分钟），服务端一次只跑一条，排队的任务网页会显示「排队中」。

### 旧派单链路（保留兼容，新装机不用配）

早期版本由 WorkBuddy 领单出声再回填。这条路还在（`scripts/serve.mjs` + `server/audio-requests.mjs`），
要配 `MCP_TOKEN`、且网站和 WorkBuddy 必须同一台电脑。本地能合成就不必用；留着只是为了老环境不炸。

```bash
node scripts/serve.mjs --claim a0f7650ae29614ed7138a2851164528f3   # 按任务号领取
node scripts/serve.mjs                                              # 持续接单
```

- `--edge` 可切微软预设音色（274 字约 10 秒），但**不是原声**，正式交付别用

## 五步

| 步 | 做什么 | 脚本 | 关键点 |
|---|---|---|---|
| 1 | 参考链接 → mp4 | `dl-link.mjs` | 抖音有反爬，curl 只拿 JS 挑战页；用无头 Chrome 从网络层截真实签名地址，带 Referer 下 |
| 2 | 人声/伴奏分离 | `sep-any.py` | HDEMUCS，伴奏 = drums+bass+other 相加归一 |
| 3 | 挑参考段 + 参考文本 | `sep-any.py` + `asr-seg.py` | 50ms RMS 滑窗挑 12s 最密人声；参考文本**必须与音频逐字一致** |
| 4 | 克隆念新文案 | `clone-tts.py` | F5-TTS 零样本；数字/百分号/缩写先归一化 |
| 5 | 质检 + 拼接 | `qc-seg.py` + ffmpeg | 逐段转写按**拼音**比对覆盖率，<96% 或段首 <90% 自动重渲（最多 3 次） |

## 音色档案（省时间的关键）

`.workbuddy/voices/<sha1(链接)[:12]>/`：

- `ref.wav` — 12 秒干净人声，音色来源
- `ref.txt` — 参考段说的话，**手工改一遍更稳**
- `bgm.mp3` — 分离出的伴奏
- `meta.json` — 来源、时间跨度、`refTextVerified`

同一个链接第二次用零成本，不再下载分离。`refTextVerified: false` 时建议先听一遍 `ref.wav`、照实改 `ref.txt` 再置 true。

## 文案预处理（自动，不用手动做）

`tts_normalize.py` 在合成前自动转：

| 原文 | 喂给模型 |
|---|---|
| 超100块 / 2度电 / 85% | 超一百块 / 二度电 / 百分之八十五 |
| 3-5倍 | 三到五倍 |
| 40%+ | 百分之四十以上 |
| XRT智能分选机 | X R T智能分选机 |

最后一条是硬结论：**粘连的多字母缩写会被整段吞掉，拆成单字母就念得出来；但单个字母（X射线）不能拆**。

## 性能（本机 CPU，无独显）

274 字 → 5 段 → 约 12 分钟；加质检重渲可能到 19 分钟。实时率约 0.045×。
要快只能换路线：预设音色 edge-tts（10 秒，但不是原声）。

## 坑

1. **参考文本错字会毁掉音色** —— 宁可手工改，不要用 ASR 草稿直接跑。ASR 会把「获得萤石精矿」听成「破除石英、金钨」。
2. **段首吞字，根因是语速** —— `tts.infer(speed=1.2)` 不是后处理变速，是按比例压缩目标时长，塞不下就丢开头。实测同一段 43 字：`speed=1.2` 吞掉「这台智能分选」6 个字（cov 0.84），`speed=1.0` 全对（cov 1.00）。**生成一律用 1.0，要变速走 ffmpeg `atempo`**（保音高）。`--speed` 只影响 atempo，不影响模型。
3. **逐句拼会一句一句蹦** —— 每句都从起音念到降调收尾，拼起来很假。本项目按 ≤60 字切段，段内保留完整语流。
4. **concat 列表必须绝对路径** —— 相对路径会被 ffmpeg 当成相对 `concat.txt` 所在目录，二次拼错。
5. **whisper 校验必须开 VAD** —— 否则会整段吞掉近百字，误判成 TTS 丢字。
6. **多字母缩写要被吞** —— `XRT` 粘连时整段念不出（ASR 只剩「分选机」），拆成 `X R T` 就对了；但单个字母 `X射线` 不能拆，拆了反掉字。

细节见 `references/pipeline.md` 和 `references/troubleshooting.md`。

## 文件清单

| 文件 | 作用 |
|---|---|
| `scripts/dub.mjs` | 一条命令跑完五步，产出配音 + BGM 到 `out/` 和桌面 |
| `scripts/serve.mjs` | 网站领单模式：领取 → 出声 → 回填，本项目的主入口 |
| `scripts/dl-link.mjs` | 参考链接 → 本机 mp4（抖音反爬走无头 Chrome 截真实签名地址） |
| `scripts/sep-any.py` | HDEMUCS 人声/伴奏分离 + 50ms RMS 滑窗挑 12s 参考段 |
| `scripts/asr-seg.py` | 参考段转写（faster-whisper，VAD 必开） |
| `scripts/clone-tts.py` | F5-TTS 零样本克隆单段合成（恒 speed=1.0） |
| `scripts/qc-seg.py` | 拼音覆盖率质检，出 `cov` / `head` / `missing` |
| `scripts/tts_normalize.py` | 数字、百分号、缩写归一化（超100块→超一百块，XRT→X R T） |
| `scripts/_env.py` | 定位 ffmpeg/ffprobe：环境变量 → PATH → 向上找包根 `runtime/` |
| `references/pipeline.md` | 五步实现细节与算法口径 |
| `references/troubleshooting.md` | 症状 → 原因速查，含吞句首专章实测表 |
