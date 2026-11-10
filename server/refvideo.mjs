/**
 * 参考素材分析 —— 让「参考视频 / 参考配音 / 参考 BGM / 参考封面」这几栏真的起作用。
 *
 * 之前的状况：前端把这几栏的值传到了后端，后端从头到尾没读过（只有 bgm 被当成本地路径用了一下），
 * 等于填了等于没填。这里补上真正干活的逻辑：
 *
 *   1. 抽音轨      → 参考视频的 BGM 直接沿用（不再需要另外找音乐）
 *   2. 静音检测    → 参考视频的说话节奏：语音段、停顿长度 → 校准我们的配音语速与切点
 *   3. 响度测量    → 参考视频的听感基准，混音时对齐
 *
 * 只接受本机路径：抖音链接之类的远程地址不下载（下载不了还容易踩合规问题）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { run, probe, BIN } from "./util.mjs";
import { DIRS } from "./db.mjs";

const CACHE = path.join(DIRS.root, "cache", "refvideo");
fs.mkdirSync(CACHE, { recursive: true });

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".flv", ".wmv", ".ts"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".wma"]);

/** 只认本机绝对路径 */
export function isLocalPath(s){
  const v = String(s || "").trim().replace(/^["']|["']$/g, "");
  return /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith("\\\\") || v.startsWith("/");
}

/** 去掉首尾引号，把相对路径补成绝对路径 */
export function resolveLocal(s){
  let v = String(s || "").trim().replace(/^["']|["']$/g, "");
  if (!v) return null;
  if (/^https?:/i.test(v)) return null;
  try { return path.resolve(v); } catch(e){ return null; }
}

/**
 * 找参考视频旁边的文案文件：同目录、同名（basename）的 .txt / .srt / .ass。
 * 有了它才能算出参考的「字/秒」，没有就只能按句长节奏对齐。
 */
function findRefText(src){
  const dir = path.dirname(src);
  const stem = path.basename(src, path.extname(src));
  const cands = [
    path.join(dir, stem + ".txt"),
    path.join(dir, stem + ".srt"),
    path.join(dir, stem + ".ass")
  ];
  for (const c of cands){
    if (!fs.existsSync(c)) continue;
    try {
      const raw = fs.readFileSync(c, "utf8");
      let text = raw;
      if (/\.srt$/i.test(c)){
        // 去掉序号行和时间轴
        text = raw.split(/\r?\n/).filter(l => !/-->/.test(l) && !/^\d+$/.test(l.trim())).join("");
      } else if (/\.ass$/i.test(c)){
        text = raw.split(/\r?\n/).filter(l => !/^(Dialogue|Comment|Format|Style|Script|PlayRes|Wrap|Scaled|YCbCr|\[|$)/.test(l)).join("");
        // 去掉 ASS 内联标签
        text = text.replace(/\{[^}]*\}/g, "");
      }
      const chars = text.replace(/\s/g, "").length;
      if (chars > 10) return { file: c, chars };
    } catch(e){ /* 读不了就当没有 */ }
  }
  return null;
}

/**
 * 分析一个参考视频 / 参考音频。
 * @returns {ok:true, path, duration, speechMs, silenceMs, avgPauseMs, hasSpeech, speech[], loudness, spanMs, refText}
 *          {ok:false, reason}
 */
export async function analyzeReference(input, workDir, opt = {}){
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, reason: "未填参考素材路径" };
  if (/^https?:/i.test(raw))
    return { ok: false, reason: "只支持本机路径（链接不下载），请填本机视频/音频文件" };

  const src = resolveLocal(raw);
  if (!src) return { ok: false, reason: "路径不合法" };
  if (!fs.existsSync(src)) return { ok: false, reason: `路径不存在：${src}` };

  const ext = path.extname(src).toLowerCase();
  if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext))
    return { ok: false, reason: `不支持的格式：${ext || "无扩展名"}` };

  // 同一文件只分析一次（按路径 + 修改时间做 key）
  const st = fs.statSync(src);
  const key = crypto.createHash("sha1").update(`${src}|${st.mtimeMs}`).digest("hex").slice(0, 16);
  const wav = path.join(CACHE, key + ".wav");
  const meta = path.join(CACHE, key + ".json");
  if (fs.existsSync(wav) && fs.existsSync(meta)){
    try {
      const c = JSON.parse(fs.readFileSync(meta, "utf8"));
      return { ok: true, cached: true, source: src, ...c };
    } catch(e){ /* 缓存坏了就重算 */ }
  }

  // 1) 抽音轨：视频取其音轨，音频直接转 wav
  //    cwd 必须存在，否则 spawn 直接 ENOENT，报错还看不出真实原因
  if (workDir) fs.mkdirSync(workDir, { recursive: true });
  const r = await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error",
    "-i", src, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", wav],
    { cwd: workDir || CACHE, timeout: 300000 });
  if (r.code !== 0 || !fs.existsSync(wav)){
    const why = String(r.err || "").split("\n").map(s => s.trim()).filter(Boolean).pop() || `ffmpeg 退出码 ${r.code}`;
    return { ok: false, reason: `抽不出音轨（${why}）` };
  }

  // 2) 静音检测 → 说话节奏
  const rs = await run(BIN.ffmpeg, ["-hide_banner", "-i", wav,
    "-af", "silencedetect=noise=-35dB:d=0.20", "-f", "null", "-"], { timeout: 300000 });
  const pauses = [];
  let ps = -1;
  for (const line of String(rs.err || "").split("\n")){
    const a = line.match(/silence_start:\s*(-?[\d.]+)/);
    const b = line.match(/silence_end:\s*([\d.]+)/);
    if (a) ps = Math.max(0, parseFloat(a[1]));
    if (b && ps >= 0){ if (parseFloat(b[1]) > ps) pauses.push({ s: ps, e: parseFloat(b[1]) }); ps = -1; }
  }
  const info = await probe(wav);
  const duration = info?.duration || 0;

  // 语音段 = 静音段的补集
  const speech = [];
  let cur = 0;
  for (const p of pauses.slice().sort((a, b) => a.s - b.s)){
    if (p.s - cur > 0.25) speech.push({ s: cur, e: p.s });
    cur = Math.max(cur, p.e);
  }
  if (duration - cur > 0.25) speech.push({ s: cur, e: duration });
  const speechMs = Math.round(speech.reduce((a, x) => a + (x.e - x.s), 0) * 1000);
  const silenceMs = Math.round(Math.max(0, duration * 1000 - speechMs));
  const avgPauseMs = pauses.length
    ? Math.round(pauses.reduce((a, p) => a + (p.e - p.s), 0) / pauses.length * 1000)
    : 0;
  // 有规律的长静音 + 有声段 = 大概率是「有人在说话」；连续音乐不会有这种断句
  const hasSpeech = pauses.length >= 3 && speechMs > duration * 1000 * 0.15;

  // 3) 响度
  let loudness = null;
  const rl = await run(BIN.ffmpeg, ["-hide_banner", "-i", wav,
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=9:print_format=json", "-f", "null", "-"], { timeout: 300000 });
  const m = String(rl.err || "").match(/\{[\s\S]*?\}/);
  if (m){
    try {
      const j = JSON.parse(m[0]);
      loudness = { I: +j.input_i, TP: +j.input_tp, LRA: +j.input_lra };
    } catch(e){ /* 忽略 */ }
  }

  const out = {
    path: wav, duration, speechMs, silenceMs, avgPauseMs, hasSpeech, speech, pauses, loudness,
    // 说话跨度：第一句开头到最后一句结尾，中间含停顿 —— 拿来跟我们的配音跨度对齐
    spanMs: speech.length ? Math.round((speech[speech.length - 1].e - speech[0].s) * 1000) : 0,
    // 参考文案（同目录同名 txt/srt/ass）：有它才能算参考的「字/秒」
    refText: findRefText(src)
  };
  fs.writeFileSync(meta, JSON.stringify(out), "utf8");
  return { ok: true, source: src, ...out };
}

/**
 * 把参考视频的说话节奏映射到我们的时间轴上：
 * 返回参考语音段起点（毫秒），供镜头切点吸附用 —— 「卡参考的说话点」。
 */
export function refAnchors(ref){
  if (!ref?.ok || !ref.speech?.length) return [];
  return ref.speech.map(s => Math.round(s.s * 1000));
}

/** 参考视频/参考配音的一句话说明，进任务日志 */
export function refSummary(ref){
  if (!ref?.ok) return "";
  const bits = [`时长 ${ref.duration.toFixed(1)}s`];
  bits.push(ref.hasSpeech
    ? `说话 ${(ref.speechMs / 1000).toFixed(1)}s / ${ref.speech.length} 段 / 平均停顿 ${ref.avgPauseMs}ms`
    : "无明显说话段（按纯音乐处理）");
  if (ref.loudness) bits.push(`参考响度 ${ref.loudness.I.toFixed(1)} LUFS`);
  return bits.join(" · ");
}
