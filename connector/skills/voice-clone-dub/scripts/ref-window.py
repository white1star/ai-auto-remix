# -*- coding: utf-8 -*-
"""把参考音频裁成 GPT-SoVITS 能吃的窗口（3~10 秒），并同步截出对应的参考文本。

为什么需要它：GPT-SoVITS 对 prompt 音频有硬限制——
  File ".../TTS_infer_pack/TTS.py", _set_prompt_semantic
  raise OSError(i18n("参考音频在3~10秒范围外，请更换！"))
而项目里的音色档案是从视频里切出来的，动辄 12 秒以上（当前这个 12.3 秒）。

不能简单 `ffmpeg -t 8`：参考文本必须和音频逐字对应，切点落在字中间或文本没跟着截，
韵律对齐就废了，音色会飘。所以先做词级时间戳，再把文本和音频一起按同一个字边界切。

对齐方式：whisper 对这类短视频人声同音错很多（实测把「获得萤石精矿」听成「破除石英金钨」），
所以不按字面比，按拼音比（difflib 在拼音序列上找最长匹配块），把每个参考文本的字
映射到一个时间戳，再挑窗口。

输出：
  <prefix>.wav / <prefix>.txt   → 裁好的参考音频与文本（≤10s）
  OK <sec> <chars>              → 机器可读结果，clone.mjs 靠这行判断
  SKIP <原时长>                  → 本来就在 3~10 秒内，直接用原文件

用法：
  ref-window.py --ref ref.wav --text ref.txt --out-dir <dir> [--prefix ref_gsv]
                [--max 9.6] [--min 3.2] [--want 8.0]
"""
import argparse
import difflib
import json
import os
import subprocess
import sys
import wave

for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
os.environ["HF_HUB_OFFLINE"] = "1"

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _env import FFMPEG, FFPROBE  # noqa: E402

# whisper 模型和热词跟 leak-trim.py / asr-seg.py 保持一致，省的换行业要改两处
MODEL = os.environ.get("ASR_MODEL") or os.path.expandvars(
    r"%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-large-v3"
    r"\snapshots\edaa852ec7e145841d8ffdb056a99866b5f0a478"
)
PROMPT = ("以下是普通话口播，矿业选矿广告。常见词：萤石、金钨、硫砷、电磁窑、密闭煅烧、"
          "气化分离、回收率、品位、XRT智能分选机、抛废、入磨、干选、磨矿浮选、精矿。")


def is_content(ch):
    return ("\u4e00" <= ch <= "\u9fa5") or ch.isalnum()


def py(ch):
    if "\u4e00" <= ch <= "\u9fa5":
        from pypinyin import lazy_pinyin
        return lazy_pinyin(ch)[0]
    return ch.lower()


def duration(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def load16k(path):
    with wave.open(path) as w:
        sr, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if sr != 16000:
        tmp = path + ".16k.wav"
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", path,
                        "-ar", "16000", "-ac", "1", tmp], check=True)
        with wave.open(tmp) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
        os.remove(tmp)
    return x


def char_times(wav):
    """词级时间戳 → 逐字时间。词内按等分给时间，够挑窗口用。"""
    from faster_whisper import WhisperModel
    m = WhisperModel(MODEL, device="cpu", compute_type="int8", local_files_only=True)
    segs, _ = m.transcribe(load16k(wav), language="zh", vad_filter=False, beam_size=5,
                           condition_on_previous_text=False,
                           initial_prompt=PROMPT, word_timestamps=True)
    out = []
    for s in segs:
        for w in (s.words or []):
            t = (w.word or "").strip()
            cs = [c for c in t if is_content(c)]
            if not cs:
                continue
            step = max(0.0, float(w.end) - float(w.start)) / len(cs)
            for j, c in enumerate(cs):
                out.append({"c": c, "p": py(c), "s": float(w.start) + step * j,
                            "e": float(w.start) + step * (j + 1)})
    return out


def align_alpha(rtext, hyp):
    """把参考文本的每个字映射到 hyp 里的时间。

    按拼音序列做最长匹配（SequenceMatcher），同音字也能对上；
    匹配不上的字用前后锚点线性插值，保证每个字都有时间。
    """
    rt = [(i, c) for i, c in enumerate(rtext) if is_content(c)]
    if not rt or not hyp:
        return None
    a = [py(c) for _, c in rt]
    b = [h["p"] for h in hyp]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    times = [None] * len(rt)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            times[blk.a + k] = (hyp[blk.b + k]["s"], hyp[blk.b + k]["e"])
    # 没锚上的按前后已知点插值
    known = [i for i, t in enumerate(times) if t]
    if not known:
        return None
    for i in range(len(times)):
        if times[i] is None:
            prev = max([k for k in known if k < i], default=None)
            nxt = min([k for k in known if k > i], default=None)
            if prev is None:
                times[i] = times[nxt]
            elif nxt is None:
                times[i] = times[prev]
            else:
                span = nxt - prev
                frac = (i - prev) / span if span else 0
                times[i] = (times[prev][0] + (times[nxt][0] - times[prev][0]) * frac,
                            times[prev][1] + (times[nxt][1] - times[prev][1]) * frac)
    return rt, times


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--ref", required=True)
    p.add_argument("--text", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--prefix", default="ref_gsv")
    p.add_argument("--max", type=float, default=9.6, help="窗口上限（GPT-SoVITS 硬限 10s）")
    p.add_argument("--min", type=float, default=3.2)
    p.add_argument("--want", type=float, default=8.0, help="理想窗口长度")
    a = p.parse_args()

    a.ref = os.path.abspath(a.ref)
    a.text = os.path.abspath(a.text)
    a.out_dir = os.path.abspath(a.out_dir)
    rtext = open(a.text, encoding="utf-8").read().strip()
    dur = duration(a.ref)

    if 3.0 <= dur <= 10.0:
        print("SKIP %.3f" % dur, flush=True)
        print(json.dumps({"ref": a.ref, "txt": a.text, "dur": dur, "trimmed": False},
                         ensure_ascii=False))
        return

    if dur < 3.0:
        sys.exit(f"参考音频只有 {dur:.2f}s，不足 3 秒，GPT-SoVITS 用不了；换个长一点的音色样本")

    from faster_whisper import WhisperModel  # noqa: F401  提前确认依赖在
    hyp = char_times(a.ref)
    al = align_alpha(rtext, hyp)
    if not al:
        sys.exit("参考音频转写失败，没法定位切点")
    rt, times = al

    # 挑窗口：从尾部往前找，取「时长最接近 --want 且不超 --max」的那个字边界。
    # 从尾部切是有意的——尾巴是最新鲜的韵律，头部被掐掉不影响音色。
    best = None
    for k, (ch_i, _ch) in enumerate(rt):
        t0 = max(0.0, times[k][0] - 0.06)      # 往前留一点点，别把字头削掉
        d = dur - t0
        if d > a.max or d < a.min:
            continue
        score = abs(d - a.want)
        # 优先在标点后面起（那边本来就是换气点，切出来更干净）
        prev = rtext[:ch_i].rstrip()
        if prev and prev[-1] in "，。！？、；：,.!?;:":
            score -= 0.8
        if best is None or score < best[0]:
            best = (score, k, t0, ch_i)

    if best is None:
        # 兜底：整条音频按字数均分估一个切点，宁可糙也别不给结果
        t0 = max(0.0, dur - a.want)
        keep = int(len(rt) * (a.want / dur))
        best = (0, max(0, len(rt) - keep), t0, rt[max(0, len(rt) - keep)][0])

    _, k, t0, ch_i = best
    new_text = rtext[ch_i:].strip(" ，,、；;")
    new_dur = dur - t0
    if len(new_text) < 6 or new_dur < 3.0:
        sys.exit(f"裁出来的窗口不合适（{new_dur:.2f}s / {len(new_text)} 字），请手工确认参考音频")

    os.makedirs(a.out_dir, exist_ok=True)
    out_wav = os.path.join(a.out_dir, a.prefix + ".wav")
    out_txt = os.path.join(a.out_dir, a.prefix + ".txt")
    fo = max(0.0, new_dur - 0.30)
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-ss", "%.3f" % t0, "-i", a.ref,
                    "-af", "afade=t=in:st=0:d=0.02,afade=t=out:st=%.3f:d=0.28" % fo,
                    "-ar", "32000", "-ac", "1", "-c:a", "pcm_s16le", out_wav], check=True)
    open(out_txt, "w", encoding="utf-8").write(new_text)

    real = duration(out_wav)
    print("OK %.3f %d" % (real, len(new_text)), flush=True)
    print(json.dumps({"ref": out_wav, "txt": out_txt, "dur": round(real, 3),
                      "trimmed": True, "start": round(t0, 3), "origDur": round(dur, 3),
                      "text": new_text}, ensure_ascii=False))


if __name__ == "__main__":
    main()
