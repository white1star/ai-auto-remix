"""
F5-TTS 零样本音色复刻 —— 用参考音频的音色念新文案。
全本地：权重目录由 F5_HOME 指定，不联网。

用法:
  python clone-tts.py --ref ref_voice.wav --ref-text "参考音频里说的话" \
      --gen-text "要念的新文案" --out out.wav [--speed 1.0] [--nfe 16]
"""
import argparse
import os
import sys
import time

# HF 被墙，只走本地权重；顺便让任何漏网的下载都落到镜像上
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)

# F5 权重（model_1250000.safetensors + vocab.txt + vocos），默认放在技能目录的 weights/f5 下
HERE = os.path.dirname(os.path.abspath(__file__))
F5 = os.environ.get("F5_HOME") or os.path.normpath(os.path.join(HERE, "..", "weights", "f5"))
CKPT = os.path.join(F5, "model_1250000.safetensors")
VOCAB = os.path.join(F5, "vocab.txt")
VOCODER = os.path.join(F5, "vocos")

p = argparse.ArgumentParser()
p.add_argument("--ref", required=True, help="参考音频路径")
p.add_argument("--ref-text", default="", help="参考音频里说的是什么（必须逐字一致）")
p.add_argument("--ref-text-file", default="", help="从文件读参考文本，优先级高于 --ref-text")
p.add_argument("--gen-text", default="", help="要念的新文案")
p.add_argument("--gen-text-file", default="", help="从文件读新文案，优先级高于 --gen-text")
# 批量模式：一行一段，模型只加载一次。
# 逐行配音必须走这条路——每行单起一个进程要重载 40s 的模型，16 行就是 10 分钟白等。
p.add_argument("--gen-list", default="", help="批量：一行一段的文本文件")
p.add_argument("--out-dir", default="", help="批量模式的输出目录（seg_00.wav …）")
p.add_argument("--out", default="")
p.add_argument("--speed", type=float, default=1.0)
p.add_argument("--speed-list", default="", help="批量：一行一个语速倍数，和 --gen-list 逐行对齐，空行沿用 --speed")
p.add_argument("--nfe", type=int, default=32, help="采样步数，CPU 上可降到 16 换速度")
p.add_argument("--device", default="cpu")
p.add_argument("--raw", action="store_true", help="不做中文读法归一化（默认归一化：数字/百分号/符号）")
a = p.parse_args()

if a.ref_text_file:
    a.ref_text = open(a.ref_text_file, encoding="utf-8").read().strip()
if a.gen_text_file:
    a.gen_text = open(a.gen_text_file, encoding="utf-8").read().strip()

# 批量：每行一段。空行丢掉，行内换行不可见字符清掉。
BATCH = bool(a.gen_list)
GEN_SPEEDS = []
if BATCH:
    if not a.out_dir:
        sys.exit("批量模式要给 --out-dir")
    raw_lines = open(a.gen_list, encoding="utf-8").read().splitlines()
    # 逐行语速：短句要念慢一点，否则模型按文字长度分配时长，短句本身就短，
    # 再把开头漏掉的那半个字裁掉，剩下的字就赶得飞快。
    sp_list = []
    if a.speed_list:
        sp_list = [(float(x) if x.strip() else a.speed)
                   for x in open(a.speed_list, encoding="utf-8").read().splitlines()]
    GEN_TEXTS = []
    for idx, line in enumerate(raw_lines):
        t = line.replace("\u200b", "").strip()
        if not t:
            continue
        GEN_TEXTS.append(t)
        GEN_SPEEDS.append(sp_list[idx] if idx < len(sp_list) else a.speed)
else:
    GEN_TEXTS = [a.gen_text]

if not a.ref_text or not any(GEN_TEXTS):
    sys.exit("缺参考文本或新文案（--ref-text-file / --gen-text-file / --gen-list）")
if not BATCH and not a.out:
    sys.exit("单段模式要给 --out")

# 中文零样本模型直接吃「100块 / 85% / 850度」会念糊（实测出过「超王横置快」这种乱码）。
# 数字先转成中文读法再喂；参考文本同样要转，否则文本与音频对不齐，韵律会被带歪。
if not a.raw:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from tts_normalize import normalize as _norm

    before = a.ref_text
    a.ref_text = _norm(before, expand_latin=True)
    if before != a.ref_text:
        print(f"  ref_text 归一化 {len(before)}→{len(a.ref_text)} 字", flush=True)
    for i, t in enumerate(GEN_TEXTS):
        after = _norm(t, expand_latin=True)
        if after != t:
            print(f"  gen_text[{i}] 归一化 {len(t)}→{len(after)} 字", flush=True)
        GEN_TEXTS[i] = after

for f, label in ((CKPT, "主模型"), (VOCAB, "词表"), (os.path.join(VOCODER, "pytorch_model.bin"), "声码器")):
    if not os.path.exists(f):
        sys.exit(f"缺 {label}: {f}")
    print(f"  {label:6s} {os.path.getsize(f)/1048576:7.1f} MB  {os.path.basename(f)}")

t0 = time.time()

# torchaudio 2.11 的 load 走 torchcodec，需要 FFmpeg 共享库 DLL，本机没有会直接崩。
# 用 soundfile 顶掉它——只读参考音频，够用，且不依赖 FFmpeg 动态库。
import numpy as _np
import soundfile as _sf
import torch as _torch
import torchaudio as _ta


def _load_audio(path, **kw):
    data, sr = _sf.read(str(path), dtype="float32", always_2d=True)
    return _torch.from_numpy(_np.ascontiguousarray(data.T)), sr


_ta.load = _load_audio

# ---- 关于参考音频尾字漏进每段开头（已解决，别再从这里下手）----
# F5 预处理末尾是 remove_silence_edges() + silent(50ms)，把参考音频首尾静音全裁掉只补 50ms，
# 模型拿到的是一条「说完最后一个字就断」的音频，按续写方式生成时会把尾字带出来
# （参考音频最后一句是「…都在85%以上」，于是每段开头都先冒一个「上」）。
# 试过三种堵法全部无效：给 ref 补 450ms 留白、afade 淡出、patch remove_silence_edges 只裁头。
# 泄漏是模型的续写行为，不是切分点算错。现在改在合成之后用词级时间戳定位正文起点再裁，
# 见 scripts/leak-trim.py 与 server/clone.mjs 里的 leakCuts。

from f5_tts.api import F5TTS

print(f"加载模型 → {a.device} …", flush=True)
tts = F5TTS(
    model="F5TTS_v1_Base",
    ckpt_file=CKPT,
    vocab_file=VOCAB,
    vocoder_local_path=VOCODER,
    device=a.device,
)
print(f"模型就绪 {time.time()-t0:.1f}s，开始合成（{len(GEN_TEXTS)} 段 / 共 {sum(len(t) for t in GEN_TEXTS)} 字，nfe={a.nfe}）…", flush=True)

if BATCH:
    os.makedirs(a.out_dir, exist_ok=True)

for i, gtext in enumerate(GEN_TEXTS):
    out = os.path.join(a.out_dir, "seg_%02d.wav" % i) if BATCH else a.out
    t1 = time.time()
    wav, sr, _ = tts.infer(
        ref_file=a.ref,
        ref_text=a.ref_text,
        gen_text=gtext,
        nfe_step=a.nfe,
        speed=(GEN_SPEEDS[i] if BATCH and i < len(GEN_SPEEDS) else a.speed),
        file_wave=out,
        show_info=lambda *x, **k: None,
    )
    dur = len(wav) / sr
    el = time.time() - t1
    if BATCH:
        # 有效语音时长（掐掉首尾静音）：语速要按这个算，不是按整段。
        # F5 每段开头都垫 0.2–0.35s 静音，拿整段时长除以字数会把语速低估 20% 以上。
        try:
            import numpy as _np
            x = _np.abs(_np.asarray(wav, dtype="float32").reshape(-1))
            if x.size:
                thr = max(1e-4, float(x.max()) * 0.03)
                idx = _np.where(x > thr)[0]
                speech = float((idx[-1] - idx[0] + 1) / sr) if idx.size else 0.0
            else:
                speech = 0.0
        except Exception:
            speech = dur
        # 机器可读：id / 总时长 / 字数 / 本段耗时 / 有效语音时长
        print("SEG %d %.3f %d %.1f %.3f" % (i, dur, len(gtext), el, speech), flush=True)
    else:
        print(f"完成 {el:.1f}s · 采样率 {sr} · 时长 {dur:.2f}s · 输出 {out}")
        print(f"实时率 {dur/el if el else 0:.2f}x（越大越快）")

if BATCH:
    print("BATCH OK %d 段" % len(GEN_TEXTS), flush=True)
