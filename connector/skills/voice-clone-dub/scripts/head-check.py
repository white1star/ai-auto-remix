# -*- coding: utf-8 -*-
"""整轨级「段首残留」检查：对着拼好的配音听一遍，看每句开头有没有多出来的音节。

为什么不信逐段检测：1–2 秒的短音频上 whisper 幻觉很重，段首那半个漏字经常听不出来
（实测逐段判干净，整轨转写却是「上设备没回本」）。整条轨有上下文，准确率高得多，
而且这才是听众真正听到的东西。

用法：
  head-check.py <配音.wav> <segments.json>
segments.json: [{"i":1,"t0":0.0,"t1":2.21,"text":"你知道什么叫矿没选出来"}, ...]

输出每行一个 JSON：{"i":1,"junk":0.14,"heard":"上","ok":false}
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

# 小于这个时长的残留当噪声，不算（一个字的六分之一，听不出来）
NOISE = float(os.environ.get("HEAD_NOISE", "0.09"))


def py(ch):
    return lazy_pinyin(ch)[0] if "\u4e00" <= ch <= "\u9fa5" else ch.lower()


def is_content(ch):
    return ("\u4e00" <= ch <= "\u9fa5") or ch.isalnum()


def load16k(path):
    with wave.open(path) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
    if sr != 16000:
        import subprocess
        from _env import FFMPEG as ff
        tmp = os.path.abspath(path) + ".16k.wav"
        subprocess.run([ff, "-y", "-loglevel", "error", "-i", path,
                        "-ar", "16000", "-ac", "1", tmp], check=True)
        with wave.open(tmp) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
        os.remove(tmp)
    return x


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: head-check.py <配音.wav> <segments.json>")
    wav, segfile = sys.argv[1], sys.argv[2]
    segs = json.load(open(segfile, encoding="utf-8"))

    m = WhisperModel(MODEL, device="cpu", compute_type="int8", local_files_only=True)
    chunks, _ = m.transcribe(load16k(wav), language="zh", vad_filter=False, beam_size=5,
                             condition_on_previous_text=False, initial_prompt=PROMPT,
                             word_timestamps=True)

    # 整轨一次转写，拆成「字 + 绝对时间」
    chars = []
    for c in chunks:
        for w in (c.words or []):
            t = (w.word or "").strip()
            cs = [ch for ch in t if is_content(ch)]
            n = len(cs)
            if not n:
                continue
            step = max(0.0, float(w.end) - float(w.start)) / n
            for j, ch in enumerate(cs):
                chars.append({"c": ch, "p": py(ch), "s": float(w.start) + step * j})

    for s in segs:
        tgt = [py(ch) for ch in s["text"] if is_content(ch)]
        t0, t1 = float(s["t0"]), float(s["t1"])
        junk, heard = 0.0, ""
        if len(tgt) >= 2:
            # 只看这一句范围内的字
            local = [c for c in chars if t0 - 0.06 <= c["s"] < t1 + 0.12]
            start = None
            for N in (5, 4, 3, 2):
                if N > len(tgt):
                    continue
                head = tgt[:N]
                for k in range(len(local) - N + 1):
                    if [local[k + j]["p"] for j in range(N)] == head:
                        start = k
                        break
                if start is not None:
                    break
            if start is not None:
                junk = max(0.0, local[start]["s"] - t0)
                heard = "".join(c["c"] for c in local[:start])
        ok = junk <= NOISE
        print(json.dumps({"i": s["i"], "junk": round(junk, 3), "heard": heard, "ok": ok},
                         ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
