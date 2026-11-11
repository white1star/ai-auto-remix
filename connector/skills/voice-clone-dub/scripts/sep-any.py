# -*- coding: utf-8 -*-
"""任意视频/音频 → 干净人声 + 伴奏 + 一段最适合当参考音色的语音窗口。

用法:
  python dev/sep-any.py <输入媒体> <输出目录>
产出:
  <out>/vocals.wav     分离出的人声（44.1k 立体声）
  <out>/bgm.wav        分离出的伴奏（除人声外的所有声部相加）
  <out>/ref_seg.wav    挑出来的参考段（24k 单声道，10–13 秒）
  <out>/ref_span.json  参考段在 vocals 里的起止秒数
只在 py3.12（装了 torch/torchaudio）里跑。
"""
import json
import os
import subprocess
import sys
import wave

for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)

import numpy as np
import torch
import torchaudio

def _ffmpeg():
    """优先 FFMPEG 环境变量，其次 PATH，最后从技能目录向上找包根的 runtime"""
    from _env import find_ffmpeg
    return find_ffmpeg()


FFMPEG = _ffmpeg()

SRC, OUTDIR = sys.argv[1], sys.argv[2]
os.makedirs(OUTDIR, exist_ok=True)
TMP = os.path.join(OUTDIR, "_in44.wav")


def read_wav(p):
    w = wave.open(p, "rb")
    n, ch, sr = w.getnframes(), w.getnchannels(), w.getframerate()
    raw = w.readframes(n)
    w.close()
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return torch.from_numpy(np.ascontiguousarray(a.reshape(-1, ch).T)), sr


def write_wav(p, t, sr):
    a = np.clip(t.detach().cpu().numpy().T, -1.0, 1.0)
    w = wave.open(p, "wb")
    w.setnchannels(a.shape[1])
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes((a * 32767.0).astype(np.int16).tobytes())
    w.close()


subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", SRC,
                "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", TMP], check=True)

bundle = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS
model = bundle.get_model()
model.eval()

wav, sr = read_wav(TMP)
dur = wav.shape[-1] / sr
print(f"输入 {dur:.2f}s")
torch.set_num_threads(max(1, os.cpu_count() or 4))
print("分离中（CPU）…", flush=True)
with torch.no_grad():
    sources = model(wav[None])[0]

names = ["drums", "bass", "other", "vocals"]
for i, n in enumerate(names):
    write_wav(os.path.join(OUTDIR, f"stem_{n}.wav"), sources[i], sr)

voc = sources[names.index("vocals")]
write_wav(os.path.join(OUTDIR, "vocals.wav"), voc, sr)
# 伴奏 = 其余三路相加
bgm = sources[[0, 1, 2]].sum(dim=0)
bgm = bgm / max(1e-6, float(bgm.abs().max())) * 0.95
write_wav(os.path.join(OUTDIR, "bgm.wav"), bgm, sr)
print(f"人声/伴奏已导出 · {voc.shape[-1]/sr:.2f}s")

# ---- 挑参考段：取「有声帧最密」的 12 秒窗口，避开首尾 ----
mono = voc.mean(dim=0).numpy()
step = int(0.05 * sr)
rms = np.array([np.sqrt((mono[i:i + step] ** 2).mean()) for i in range(0, len(mono) - step, step)])
thr = max(rms.mean() * 0.6, np.percentile(rms, 40))
voiced = rms > thr

WIN = 12.0
if dur <= WIN + 1:
    start = 0.0
else:
    best, best_score = 0.0, -1
    t = 0.5
    while t + WIN < dur - 0.3:
        i, j = int(t / 0.05), int((t + WIN) / 0.05)
        score = voiced[i:j].mean()
        # 越靠前略加分，避免挑到结尾的拖音
        score -= 0.02 * (t / max(1.0, dur))
        if score > best_score:
            best_score, best = score, t
        t += 0.5
    start = best
end = min(dur, start + WIN)

subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                "-ss", f"{start:.2f}", "-to", f"{end:.2f}",
                "-i", os.path.join(OUTDIR, "vocals.wav"),
                "-ar", "24000", "-ac", "1", os.path.join(OUTDIR, "ref_seg.wav")], check=True)

json.dump({"start": round(start, 2), "end": round(end, 2), "dur": round(end - start, 2),
           "voiced_ratio": round(float(best_score), 3)},
          open(os.path.join(OUTDIR, "ref_span.json"), "w"), ensure_ascii=False)
print(f"参考段 {start:.2f}–{end:.2f}s（{end-start:.2f}s，有声占比 {best_score*100:.0f}%）")
