# -*- coding: utf-8 -*-
"""转写一段音频，输出纯文本（给 F5 当 ref_text 用）。
必须和参考音频逐字一致，所以用带标点的输出、不做任何改写。
只在 py3.13（装了 faster-whisper）里跑。"""
import os
import sys
import wave

for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
os.environ["HF_HUB_OFFLINE"] = "1"

import numpy as np
from faster_whisper import WhisperModel

MODEL = os.environ.get("ASR_MODEL") or os.path.expandvars(
    r"%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-large-v3"
    r"\snapshots\edaa852ec7e145841d8ffdb056a99866b5f0a478"
)
AUDIO, OUT = sys.argv[1], sys.argv[2]

# 参考文本只用来给 F5 对齐韵律，同音字错会毁掉效果。塞领域词让模型往这些词上靠。
# 换行业时改这里，或设环境变量 ASR_HOTWORDS / ASR_PROMPT。
HOTWORDS = os.environ.get("ASR_HOTWORDS") or (
    "萤石 萤石砂 萤石精矿 石英 石英砂 金 钨 金钨 硫砷 硫 砷 银 铅 锌 铜 钼 "
    "电磁窑 回转窑 煅烧 密闭煅烧 气化分离 焙烧 浸出 浮选 磨矿浮选 磁选 重选 "
    "回收率 品位 精矿 尾矿 抛废 入磨 破碎 干选 分选 分选机 XRT X射线 "
    "吨选矿成本 信息差 试验报告 选矿试验 纯度 4N 日产"
)

PROMPT = os.environ.get("ASR_PROMPT") or (
    "以下是普通话口播，矿业选矿广告。常见词：萤石、萤石砂、萤石精矿、金、钨、硫砷、"
    "电磁窑、密闭煅烧、气化分离、回收率、品位、XRT智能分选机、X射线、抛废、入磨、"
    "干选、尾矿、磨矿浮选、分选、矿石、破碎、精矿、纯度、信息差、吨选矿成本。")

with wave.open(AUDIO) as w:
    sr = w.getframerate()
    x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
    ch = w.getnchannels()
if ch > 1:
    x = x.reshape(-1, ch).mean(axis=1)
if sr != 16000:
    import subprocess
    from _env import find_ffmpeg
    ff = find_ffmpeg()
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", AUDIO, "-ar", "16000", "-ac", "1", OUT + ".16k.wav"], check=True)
    with wave.open(OUT + ".16k.wav") as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
    os.remove(OUT + ".16k.wav")

m = WhisperModel(MODEL, device="cpu", compute_type="int8", local_files_only=True)
segs, _ = m.transcribe(
    x, language="zh", vad_filter=False, beam_size=5,
    condition_on_previous_text=False,
    initial_prompt=PROMPT,
    hotwords=HOTWORDS,
)
text = "".join(s.text for s in segs).strip()

# ---- 用「新文案」当词典，按拼音纠正参考文本里的同音错 ----
# 参考文本只影响韵律对齐，但错字太多会把音色带歪。
# 这里只在「拼音完全相同、写法不同」时替换，且优先用新文案里出现过的写法。
SCRIPT = sys.argv[3] if len(sys.argv) > 3 else ""
if SCRIPT and os.path.exists(SCRIPT):
    from pypinyin import lazy_pinyin
    script = open(SCRIPT, encoding="utf-8").read()
    def py(s):
        return "".join(lazy_pinyin(s))
    lexicon = {}
    for n in (2, 3, 4):                      # 先建短的，长的覆盖短的
        for i in range(len(script) - n + 1):
            w = script[i:i + n]
            if all("\u4e00" <= c <= "\u9fa5" for c in w):
                lexicon[py(w)] = w
    out, i, fixed = [], 0, []
    while i < len(text):
        hit = False
        for n in (4, 3, 2):                  # 从长到短找最佳匹配
            w = text[i:i + n]
            if len(w) < n or not all("\u4e00" <= c <= "\u9fa5" for c in w):
                continue
            if w in script:                  # 本来就对
                out.append(w); i += n; hit = True; break
            cand = lexicon.get(py(w))
            if cand and cand != w:
                out.append(cand); i += n; hit = True; fixed.append(f"{w}→{cand}"); break
        if not hit:
            out.append(text[i]); i += 1
    if fixed:
        print("同音纠错:", "，".join(fixed[:10]), file=sys.stderr)
    text = "".join(out)

# 去掉句末的句号，避免 F5 把句号念成停顿
text = text.rstrip("。. ")
open(OUT, "w", encoding="utf-8").write(text)
print(text)
