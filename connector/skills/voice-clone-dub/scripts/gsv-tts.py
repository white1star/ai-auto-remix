# -*- coding: utf-8 -*-
"""GPT-SoVITS v2 批量配音（接口对齐 clone-tts.py，供 server/clone.mjs 调用）。

为什么换掉 F5：F5 是「接着参考音频往下写」，每段开头必然把参考音频最后一个字
（本项目是「…85%以上」的「上」）再念一遍。用 ASR 时间戳去裁这条尾巴不可行——
whisper 的误差 ±0.2–0.3s，比漏字本身还长，切多了吞字、切少了留一声「上」。
GPT-SoVITS 的输出序列第一个 token 就是目标文本第一个字，参考音频只用来学音色，
根本不存在这条尾巴。

用法（和 clone-tts.py 一致）：
  gsv-tts.py --ref ref.wav --ref-text-file ref.txt --gen-list lines.txt \
             --out-dir out --speed 1.0 [--speed-list sp.txt] [--nfe 32]

输出（机器可读，clone.mjs 靠这行拿时长）：
  SEG <i> <总时长> <字数> <本段耗时> <有效语音时长>
  BATCH OK <段数>
"""
import argparse
import os
import sys
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
GSV = os.environ.get("GSV_HOME") or os.path.normpath(
    os.path.join(HERE, "..", "..", "..", "..", "..", ".workbuddy", "clone", "gpt-sovits-dl", "GPT-SoVITS-main")
)
if not os.path.isdir(GSV):
    sys.exit(f"找不到 GPT-SoVITS 目录：{GSV}（用 GSV_HOME 指定）")
sys.path.insert(0, GSV)

for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
os.environ["HF_HUB_OFFLINE"] = "1"

import numpy as np

# torchaudio 2.9+ 的 load() 默认走 torchcodec，而 torchcodec 与本机 torch 2.15 的 ABI 不匹配
# （libtorchcodec_core*.dll 加载失败），GPT-SoVITS 读参考音频时直接崩。
# 这里把 load() 换成 soundfile 实现：接口一致，参考音频都是 wav，不需要 FFmpeg 解码。
import torch                      # noqa: E402
import torchaudio                 # noqa: E402
import soundfile as _sf           # noqa: E402


def _ta_load(uri, frame_offset=0, num_frames=-1, normalize=True,
             channels_first=True, format=None, buffer_size=4096, backend=None):
    data, sr = _sf.read(str(uri), dtype="float32", always_2d=True)
    t = torch.from_numpy(data.T.copy() if channels_first else data.copy())
    if frame_offset:
        t = t[..., frame_offset:]
    if num_frames and num_frames > 0:
        t = t[..., :num_frames]
    return t, sr


torchaudio.load = _ta_load

p = argparse.ArgumentParser()
p.add_argument("--ref", required=True)
p.add_argument("--ref-text", default="")
p.add_argument("--ref-text-file", default="")
p.add_argument("--gen-text", default="")
p.add_argument("--gen-text-file", default="")
p.add_argument("--gen-list", default="")
p.add_argument("--out-dir", default="")
p.add_argument("--out", default="")
p.add_argument("--speed", type=float, default=1.0)
p.add_argument("--speed-list", default="", help="批量：一行一个语速，和 --gen-list 对齐")
p.add_argument("--nfe", type=int, default=32, help="兼容 F5 的入参，这里不使用")
p.add_argument("--device", default="cpu")
# 采样参数：temperature 越低越稳（咬字更准但更平），1.0 是官方默认。
# 短句（≤8 字）容易飘，clone.mjs 可以调低；试听发现咬字糊就往下调。
p.add_argument("--temperature", type=float, default=float(os.environ.get("GSV_TEMP") or 1.0))
p.add_argument("--top-k", type=int, default=int(os.environ.get("GSV_TOPK") or 15))
p.add_argument("--top-p", type=float, default=float(os.environ.get("GSV_TOPP") or 1.0))
p.add_argument("--seed", type=int, default=-1, help="-1 随机；固定值可复现")
p.add_argument("--version", default="v2", choices=["v1", "v2", "v2Pro", "v3", "v4"])
a = p.parse_args()

# GPT-SoVITS 的模块里有相对路径的资源，必须切到它目录下跑；
# 所以所有入参先在切目录之前转成绝对路径。
for k in ("ref", "ref_text_file", "gen_text_file", "gen_list", "out_dir", "out", "speed_list"):
    v = getattr(a, k)
    if v:
        setattr(a, k, os.path.abspath(v))
os.chdir(GSV)
# AR / feature_extractor / module 这些包都在 GPT_SoVITS 目录下，官方是靠 cwd 兜住的；
# 这里显式加进 sys.path，免得依赖执行目录。
sys.path.insert(0, os.path.join(GSV, "GPT_SoVITS"))
sys.path.insert(0, GSV)

if a.ref_text_file:
    a.ref_text = open(a.ref_text_file, encoding="utf-8").read().strip()
if a.gen_text_file:
    a.gen_text = open(a.gen_text_file, encoding="utf-8").read().strip()

BATCH = bool(a.gen_list)
GEN_SPEEDS = []
if BATCH:
    if not a.out_dir:
        sys.exit("批量模式要给 --out-dir")
    raw = open(a.gen_list, encoding="utf-8").read().splitlines()
    sp = []
    if a.speed_list:
        sp = [(float(x) if x.strip() else a.speed)
              for x in open(a.speed_list, encoding="utf-8").read().splitlines()]
    GEN_TEXTS = []
    for i, line in enumerate(raw):
        t = line.replace("\u200b", "").strip()
        if not t:
            continue
        GEN_TEXTS.append(t)
        GEN_SPEEDS.append(sp[i] if i < len(sp) else a.speed)
else:
    GEN_TEXTS = [a.gen_text]

if not a.ref_text or not any(GEN_TEXTS):
    sys.exit("缺参考文本或新文案")
if not BATCH and not a.out:
    sys.exit("单段模式要给 --out")

os.makedirs(a.out_dir, exist_ok=True) if BATCH else None

print(f"加载 GPT-SoVITS {a.version} → {a.device} …", flush=True)
t0 = time.time()
from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config  # noqa: E402

PM = os.path.join(GSV, "GPT_SoVITS", "pretrained_models")
CFG = os.path.join(GSV, "GPT_SoVITS", "configs", "tts_infer.yaml")
conf = TTS_Config(CFG)
# yaml 里是相对路径 + cuda，这里全部改成绝对路径 + cpu
conf.device = a.device
conf.is_half = (a.device != "cpu")
conf.bert_base_path = os.path.join(PM, "chinese-roberta-wwm-ext-large")
conf.cnhuhbert_base_path = os.path.join(PM, "chinese-hubert-base")
if a.version == "v2":
    conf.t2s_weights_path = os.path.join(PM, "gsv-v2final-pretrained",
                                         "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt")
    conf.vits_weights_path = os.path.join(PM, "gsv-v2final-pretrained", "s2G2333k.pth")
conf.version = a.version
tts = TTS(conf)
print(f"模型就绪 {time.time()-t0:.1f}s，开始合成（{len(GEN_TEXTS)} 段 / "
      f"共 {sum(len(t) for t in GEN_TEXTS)} 字）…", flush=True)


def speech_len(x, sr):
    """有效语音时长（掐掉首尾静音）：语速要按这个算，不能按整段。
    GPT-SoVITS 每段前面也会垫一点静音，用整段会低估语速。"""
    try:
        v = np.abs(np.asarray(x, dtype="float32").reshape(-1))
        if not v.size:
            return 0.0
        thr = max(1e-4, float(v.max()) * 0.03)
        idx = np.where(v > thr)[0]
        return float((idx[-1] - idx[0] + 1) / sr) if idx.size else 0.0
    except Exception:
        return len(x) / sr


for i, gtext in enumerate(GEN_TEXTS):
    out = os.path.join(a.out_dir, "seg_%02d.wav" % i) if BATCH else a.out
    spd = GEN_SPEEDS[i] if (BATCH and i < len(GEN_SPEEDS)) else a.speed
    t1 = time.time()
    gen = tts.run({
        "text": gtext,
        "text_lang": "zh",
        "ref_audio_path": a.ref,
        "prompt_text": a.ref_text,
        "prompt_lang": "zh",
        "top_k": a.top_k,
        "top_p": a.top_p,
        "temperature": a.temperature,
        "text_split_method": "cut0",     # 一行一句，已经切好了，别再切
        "batch_size": 1,
        "speed_factor": spd,
        "fragment_interval": 0.3,
        "seed": a.seed,
        "parallel_infer": True,
        "repetition_penalty": 1.35,
    })
    sr, audio = None, None
    for sr_, chunk in gen:
        sr, audio = sr_, chunk
    el = time.time() - t1
    if sr is None or audio is None:
        print(f"SEG {i} 0 0 {el:.1f} 0", flush=True)
        continue
    audio = np.asarray(audio, dtype="float32").reshape(-1)
    dur = len(audio) / sr
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    print("SEG %d %.3f %d %.1f %.3f" % (i, dur, len(gtext), el, speech_len(audio, sr)), flush=True)

if BATCH:
    print("BATCH OK %d 段" % len(GEN_TEXTS), flush=True)
