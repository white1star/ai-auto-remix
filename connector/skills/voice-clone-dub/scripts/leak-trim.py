# -*- coding: utf-8 -*-
"""找每段开头该裁多少：F5 会把参考音频的尾字漏进生成段开头（实测「上」「以上」）。

思路：转写一遍拿到词级时间戳，再和期望文本的开头逐字比对，
第一处「期望文本真实开始」的位置就是裁剪点。

输出每行一个 JSON：{"wav":..., "cut":0.35, "leak":"以上", "hyp":"..."}
"""
import json
import os
import sys
import wave

for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
os.environ["HF_HUB_OFFLINE"] = "1"

import numpy as np
from faster_whisper import WhisperModel
from pypinyin import lazy_pinyin

MODEL = os.environ.get("ASR_MODEL") or os.path.expandvars(
    r"%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-large-v3"
    r"\snapshots\edaa852ec7e145841d8ffdb056a99866b5f0a478"
)
PROMPT = ("以下是普通话口播，矿业选矿广告。常见词：萤石、金钨、硫砷、电磁窑、密闭煅烧、"
          "气化分离、回收率、品位、XRT智能分选机、抛废、入磨、干选、磨矿浮选、精矿。")


def py(ch):
    return lazy_pinyin(ch)[0] if "\u4e00" <= ch <= "\u9fa5" else ch.lower()


def is_content(ch):
    return ("\u4e00" <= ch <= "\u9fa5") or ch.isalnum()


def load16k(path):
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
    sys.exit("用法: leak-trim.py <wav> <期望文案.txt> [...]")

m = WhisperModel(MODEL, device="cpu", compute_type="int8", local_files_only=True)

for k, (wav, txtfile) in enumerate(pairs):
    target = open(txtfile, encoding="utf-8").read().strip()
    tgt_py = [py(c) for c in target if is_content(c)]
    if not tgt_py:
        print(json.dumps({"idx": k, "wav": wav, "cut": 0.0, "leak": "", "hyp": ""}, ensure_ascii=False), flush=True)
        continue

    segs, _ = m.transcribe(load16k(wav), language="zh", vad_filter=False, beam_size=5,
                           condition_on_previous_text=False,
                           initial_prompt=PROMPT, word_timestamps=True)
    words = []
    for s in segs:
        for w in (s.words or []):
            t = (w.word or "").strip()
            if t:
                words.append({"t": t, "s": float(w.start), "e": float(w.end)})

    # 把词拆成单字，词内按等分给它一个时间戳。
    # 原来按「相邻两个词的首字」比对是错的：whisper 常把「你知道」并成一个词，
    # 于是「你知道」的后一个字永远对不上期望的第二个字，第 1 句开头的「以上」
    # 就这么被漏掉了（hyp 明明是「以上,你知道…」，cut 却给 0）。
    chars = []
    for w in words:
        cs = [c for c in w["t"] if is_content(c)]
        n = len(cs)
        if not n:
            continue
        step = max(0.0, w["e"] - w["s"]) / n
        for j, c in enumerate(cs):
            chars.append({"c": c, "p": py(c), "s": w["s"] + step * j,
                          "step": step, "at_word": j == 0})

    # 找「期望文本开头」在字序列里第一次出现的位置：先试长的前缀（5 字），
    # 逐级退到 2 字，宁可少吃一点也不错切。
    cut, leak = 0.0, ""
    for N in (5, 4, 3, 2):
        if N > len(tgt_py):
            continue
        head = tgt_py[:N]
        for i in range(len(chars) - N + 1):
            if [chars[i + j]["p"] for j in range(N)] == head:
                cut = chars[i]["s"]
                # whisper 有时把「漏字 + 正文开头」并成一个词，这时字的时间只能按词内等分猜。
                # 实测漏字念得比正文慢，等分会把正文开头的字算早，裁完还剩半个漏字
                # （整轨转写里就是「以几百万上了浮选线」）。往后再让半个字的时长。
                if not chars[i]["at_word"] and i > 0:
                    cut += 0.5 * chars[i]["step"]
                leak = "".join(chars[j]["c"] for j in range(i))
                break
        else:
            continue
        break

    hyp = "".join(w["t"] for w in words)
    print(json.dumps({"idx": k, "wav": os.path.basename(wav), "cut": round(cut, 3),
                      "leak": leak, "hyp": hyp}, ensure_ascii=False), flush=True)
