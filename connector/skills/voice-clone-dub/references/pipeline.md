# 五步实现细节

## 1 拿片 — `scripts/dl-link.mjs`

抖音分享页有反爬：直接 curl 拿到的是 72KB 的 JS 挑战页，里面没有 `play_addr`。
`yt_dlp` 需要 cookies，`--cookies-from-browser chrome` 又会因为 Chrome 锁着 cookie 库而失败。

所以走无头 Chrome：

1. `chrome --headless=new --remote-debugging-port=9371 --user-data-dir=<临时目录>`
2. CDP 连上去，`Network.enable`，导航到链接
3. 监听 `Network.requestWillBeSent`，抓 `v26-web.douyinvod.com`（或 `aweme` 视频域）的请求
4. 带 `Referer: https://www.douyin.com/` 下载该地址
5. 反爬页面时会轮询 20 秒等 `<video>` 的 `readyState`，不行就 `video.play()` 再等 10 秒
6. 最后一行 stdout 打印 mp4 绝对路径

## 2 分离 — `scripts/sep-any.py`

`torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS`，4 个 stem：drums / bass / other / vocals。

- `vocals.wav` — 人声，音色来源
- `bgm.wav` = drums + bass + other 相加，逐轨归一后混，再转 192k mp3

## 3 参考段 — `scripts/sep-any.py` + `scripts/asr-seg.py`

挑段算法（决定音色像不像的关键）：

- 帧长 50ms，逐帧算 RMS
- 阈值 `thr = max(rms.mean()*0.6, percentile(rms, 40))`
- 在 10–13 秒的所有滑窗里，找「voiced 帧占比最高」的窗口，位置越靠前略有加分
- 输出 24kHz 单声道 12 秒左右片段 + `ref_span.json`（起止秒数）

参考文本（决定韵律对不对）：

- `faster-whisper-large-v3`，`beam_size=5`，`condition_on_previous_text=False`
- 塞 `initial_prompt` + `hotwords` 领域词，可用 `ASR_HOTWORDS` / `ASR_PROMPT` 覆盖
- 再用 pypinyin 建「新文案词典」，只在拼音完全相同、写法不同时替换

**ASR 只能当草稿。** 实测把「获得萤石精矿」听成「破除石英、金钨」——
参考文本错字会直接把音色带歪，所以建完档案最好人工校一遍 `ref.txt`。

## 4 克隆 — `scripts/clone-tts.py` + `scripts/tts_normalize.py`

`F5TTS(model="F5TTS_v1_Base", ckpt_file=..., vocab_file=..., vocoder_local_path=...)`

```python
tts.infer(ref_file=ref, ref_text=ref_text, gen_text=gen_text,
          nfe_step=16, speed=1.2, file_wave=out)
```

- 类名是 **大写 `F5TTS`**，旧版才是 `F5tss/F5Tts`
- `torchaudio.load` 在新版走 torchcodec，需要 FFmpeg 共享库 DLL；本机没有会崩，
  所以脚本里 monkeypatch 成 `soundfile.read`
- 权重：`SWivid/F5-TTS/F5TTS_v1_Base/model_1250000.safetensors`（1.29GB）、`vocab.txt`、
  声码器 `charactr/vocos-mel-24khz`（52MB）

文案归一化（`tts_normalize.py`），合成前对 `gen_text` 和 `ref_text` 都过一遍：

- `85%` → 百分之八十五；`3-5倍` → 三到五倍；`40%+` → 百分之四十以上
- `XRT` → `X R T`（`expand_latin=True`，只拆 ≥2 个字母的连写）
- 参考文本也要转，否则文本与音频对不齐，韵律被带歪

## 5 质检 + 拼接 — `scripts/qc-seg.py` + ffmpeg

每段合成后立刻转写，和「本该念的文案」比对：

- 汉字压拼音、字母数字保留小写、标点丢弃 → 这样「脉石/麦石」「硬选/应选」不误判
- `cov` = `SequenceMatcher` 匹配字符数 / 目标字符数
- `head` = 前 12 个 token 的覆盖率，单独算。**F5 常吞段首**，总覆盖率 0.96 也可能开头少两个字
- 不够（`cov<0.96` 或 `head<0.9`）就重渲，最多 3 次，取 `cov+head` 最高的一次
- 实测校准：念全的段 1.000；吞掉「富集」两字的段 0.961 / head 0.833

拼接：`ffmpeg -f concat -safe 0 -i list -ar 44100 -ac 1 vo.wav`，
列表里必须是**绝对路径**。

## 分段策略

按标点切，每段 ≤60 字。为什么不按句切：每句都从起音念到降调收尾，拼起来一句一句往外蹦，
短句还会念飞。段内保留完整语流，段与段之间靠标点自然停顿。
