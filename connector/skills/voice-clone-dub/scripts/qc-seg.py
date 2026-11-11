# -*- coding: utf-8 -*-
"""配音质检：把合成出来的音频转写一遍，和「本该念的文案」逐字比对，算覆盖率。

为什么要拼音比对：whisper 会把「脉石」写成「麦石」、「硬选」写成「应选」，
这些同音字其实是念对的，按汉字比会误判成丢字。统一压成拼音再比。

用法（py3.13，装了 faster-whisper）：
  python dev/qc-seg.py <wav> <期望文案.txt> [更多 wav + txt 成对]
输出：每行一个 JSON，{"wav":..., "cov":0.97, "missing":"...", "hyp":"..."}
"""
import json
import os
import sys
import wave

for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
os.environ["HF_HUB_OFFLINE"] = "1"

import numpy as np
from difflib import SequenceMatcher
from faster_whisper import WhisperModel
from pypinyin import lazy_pinyin

MODEL = os.environ.get("ASR_MODEL") or os.path.expandvars(
    r"%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-large-v3"
    r"\snapshots\edaa852ec7e145841d8ffdb056a99866b5f0a478"
)
PROMPT = ("以下是普通话口播，矿业选矿广告。常见词：萤石、萤石砂、萤石精矿、金、钨、硫砷、"
          "电磁窑、密闭煅烧、气化分离、回收率、品位、XRT智能分选机、X射线、抛废、入磨、"
          "干选、尾矿、磨矿浮选、分选、矿石、破碎、精矿、纯度、信息差、吨选矿成本。")
HOTWORDS = ("萤石 萤石精矿 石英 金钨 硫砷 电磁窑 煅烧 气化分离 浮选 回收率 品位 精矿 尾矿 "
            "抛废 入磨 破碎 干选 分选 分选机 XRT X射线 吨选矿成本 试验报告 选矿试验 纯度 日产")


def tokens(text):
    """汉字压拼音，字母数字保留小写，标点丢掉。"""
    out = []
    for ch in str(text):
        if "\u4e00" <= ch <= "\u9fa5":
            out.append(lazy_pinyin(ch)[0])
        elif ch.isalnum():
            out.append(ch.lower())
    return out


def coverage(target, hyp, head_n=12):
    t, h = tokens(target), tokens(hyp)
    if not t:
        return 1.0, "", 1.0, 0.0
    sm = SequenceMatcher(None, t, h, autojunk=False)
    matched = sum(b.size for b in sm.get_matching_blocks())
    # 找出没被匹配上的目标片段（用作「丢了什么」的提示）
    miss, pos = [], 0
    for b in sm.get_matching_blocks():
        if b.a > pos:
            miss.append((pos, b.a))
        pos = b.a + b.size
    if pos < len(t):
        miss.append((pos, len(t)))
    # 用汉字回填这些位置会更可读，但这里保持轻量，只报拼音串
    missing = " / ".join("".join(t[a:b]) for a, b in miss if b - a >= 2)

    # 段首单独算：F5 常把开头的几个字吞掉，总覆盖率还能有 0.96 看不出来，
    # 但听感上是「一句话从半截开始」，最扎耳朵。所以开头必须几乎满分。
    hn = min(head_n, len(t))
    if hn:
        hs = SequenceMatcher(None, t[:hn], h[:hn + 8], autojunk=False)
        head = sum(b.size for b in hs.get_matching_blocks()) / hn
    else:
        head = 1.0

    # 多念出来的字：hyp 里没匹配上原文的 token 占比。
    # F5 偶尔会在句尾重复半句（听感上是「叠字」），覆盖率照样 0.98 看不出来，
    # 但 extra 会明显抬头，拿它当重渲依据。
    extra = max(0, len(h) - matched) / max(1, len(t))
    return matched / len(t), missing, head, extra


def load_wav16k(path):
    with wave.open(path) as w:
        sr, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if sr != 16000:
        import subprocess
        from _env import FFMPEG as ff
        tmp = path + ".16k.wav"
        subprocess.run([ff, "-y", "-loglevel", "error", "-i", path, "-ar", "16000", "-ac", "1", tmp], check=True)
        with wave.open(tmp) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
        os.remove(tmp)
    return x


pairs = []
args = sys.argv[1:]
for i in range(0, len(args) - 1, 2):
    pairs.append((args[i], args[i + 1]))
if not pairs:
    sys.exit("用法: qc-seg.py <wav> <期望文案.txt> [...]")

m = WhisperModel(MODEL, device="cpu", compute_type="int8", local_files_only=True)
for wav, txtfile in pairs:
    target = open(txtfile, encoding="utf-8").read().strip()
    segs, _ = m.transcribe(load_wav16k(wav), language="zh", vad_filter=True, beam_size=5,
                           condition_on_previous_text=False,
                           initial_prompt=PROMPT, hotwords=HOTWORDS)
    hyp = "".join(s.text for s in segs).strip()
    cov, missing, head, extra = coverage(target, hyp)
    print(json.dumps({"wav": wav, "cov": round(cov, 3), "head": round(head, 3),
                      "extra": round(extra, 3), "missing": missing, "hyp": hyp},
                     ensure_ascii=False), flush=True)
