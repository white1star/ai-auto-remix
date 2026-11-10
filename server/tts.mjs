/**
 * TTS 层 —— 整段合成（vo_whole），不是逐句拼。
 *
 * 为什么必须整段：逐句合成等于「几十个人各念一句再粘起来」。每句都从起音念到降调收尾，
 * 拼上之后一句一句往外蹦，短句还会被念飞（5 个字 0.6 秒念完，而全片平均 5.5 字/秒）。
 * 整段一次过，停顿由标点自己给：句号约 0.5s、逗号约 0.25s、问号带升调，语流是连贯的。
 *
 * 时间轴从哪来：edge-tts 合成时服务端会回 WordBoundary，CLI 的 --write-subtitles 落地成 SRT。
 * 那是句级的真实时间，拿它做锚点、按字符位置在句内插值，就能回填每一行的 t0/t1，
 * 并顺手得到「字格」——切点吸附要用它，保证切在字上而不是切在半截音里。
 */
import fs from "node:fs";
import path from "node:path";
import { run, probe, BIN, sha1 } from "./util.mjs";
import { DIRS } from "./db.mjs";

const CACHE = path.join(DIRS.root, "cache", "tts");
fs.mkdirSync(CACHE, { recursive: true });

// 云希这个音色已按用户要求拉黑，永远不要再加回来（用户要的是参考片本人的声音）。
// 下面这些合成音色只在「主动关掉内置人声、要网站自己念文案」时才会用到。
export const VOICES = [
  { id: "zh-CN-YunjianNeural", label: "云健 · 男声 · 浑厚" },
  { id: "zh-CN-YunyangNeural", label: "云扬 · 男声 · 播报" },
  { id: "zh-CN-YunxiNeural",   label: "云希 · 男声 · 年轻" },
  { id: "zh-CN-YunxiaNeural",  label: "云夏 · 男声 · 少年" },
  { id: "zh-CN-XiaoxiaoNeural",label: "晓晓 · 女声 · 亲和" },
  { id: "zh-CN-XiaoyiNeural",  label: "晓伊 · 女声 · 明亮" },
  { id: "zh-CN-liaoning-XiaobeiNeural", label: "晓北 · 女声 · 东北话" },
  { id: "zh-CN-shaanxi-XiaoniNeural",   label: "晓妮 · 女声 · 陕西话" }
];
export const DEFAULT_VOICE = "zh-CN-YunjianNeural";

/** 片头留白 / 片尾留白（毫秒），对应 skill 的 lead / tail */
export const LEAD_MS = 280;
export const TAIL_MS = 750;

let engineCache = null;
/** 探测可用引擎，结果缓存 5 分钟 */
export async function detectEngine(force){
  if (!force && engineCache && Date.now() - engineCache.at < 300000) return engineCache.engine;
  let engine = "none";
  const r = await run(BIN.edgeTts, ["--version"], { timeout: 8000 });
  if (r.code === 0) engine = "edge-tts";
  engineCache = { engine, at: Date.now() };
  return engine;
}

const rateArg = speed => {
  const pct = Math.round((Number(speed || 1) - 1) * 100);
  if (!pct) return null;
  return `--rate=${pct > 0 ? "+" : ""}${pct}%`;
};
const pitchArg = pitch => {
  const s = String(pitch ?? "").trim();
  if (!s || s === "0") return null;
  return `--pitch=${/^[+-]/.test(s) ? s : "+" + s}`;
};

/** 无 TTS 时的时长估算：中文约 5.2 字/秒，标点略停顿 */
export function estimateDuration(text){
  const s = String(text || "").replace(/\s/g, "");
  const chars = s.length;
  const pauses = (s.match(/[，、。！？；：,.!?;:]/g) || []).length;
  return Math.max(900, Math.round(chars / 5.2 * 1000 + pauses * 180));
}

const PUNCT = /[，。！？；：、,.!?;:…—]$/;

/**
 * 把若干行拼成一段完整的话，并记下每行在整段里的字符区间。
 *
 * 有两路：
 *  - 传了 wholeText（用户原文）：直接用原文合成，一个标点都不加。
 *    切句只用于字幕/分镜，硬切出来的短句之间没有标点，不能在中间塞「，」，
 *    否则配音会在「一年少赚的，钱都够…」「能差出，20个点」这种地方乱停顿。
 *  - 没传 wholeText（老调用）：行末没标点的补一个，保证服务端能分句拿时间锚点。
 */
function buildWhole(lines, wholeText){
  if (wholeText){
    const text = String(wholeText);
    const spans = [];
    let cur = 0;
    for (const line of lines){
      const body = String(line).trim();
      const idx = text.indexOf(body, cur);
      const ls = idx >= 0 ? idx : cur;
      spans.push({ ls, le: ls + body.length, bodyEnd: ls + body.length });
      cur = ls + body.length;
    }
    return { text, spans };
  }

  let text = "";
  const spans = [];
  lines.forEach((line, i) => {
    const body = String(line).trim();
    // 一行 = 一句：行末必须是句末标点，TTS 才会在这儿真正停下来换气。
    // 原来补的是「，」，停顿只有一两百毫秒，连续十几行听着像一口气念完。
    // 行末本来就是逗号/顿号/分号的，直接换成句号（长度不变，字符对齐不受影响）。
    const soft = /[，,、；;：:]$/;
    const hard = /[。！？!?…]$/;
    let seg;
    if (hard.test(body)) seg = body;
    else if (soft.test(body)) seg = body.slice(0, -1) + "。";
    else seg = body + "。";
    spans.push({ ls: text.length, le: text.length + body.length, bodyEnd: text.length + seg.length });
    text += seg;
  });
  return { text, spans };
}

/** 解析 SRT：只要起止时间和文字 */
function parseSrt(raw){
  const out = [];
  const blocks = String(raw || "").replace(/\r/g, "").split(/\n\n+/);
  for (const b of blocks){
    const rows = b.split("\n").map(s => s.trim()).filter(Boolean);
    if (rows.length < 2) continue;
    const ti = rows.findIndex(r => r.includes("-->"));
    if (ti < 0) continue;
    const m = rows[ti].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const t0 = ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000) + +m[4];
    const t1 = ((+m[5] * 3600 + +m[6] * 60 + +m[7]) * 1000) + +m[8];
    const text = rows.slice(ti + 1).join(" ").trim();
    if (text) out.push({ t0, t1, text });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

/**
 * 把 SRT 的句级时间摊成「字符 → 时间」的查找表，再按行区间取 t0/t1。
 * cue 里的文字应当和整段原文逐字一致；万一对不上（服务端改了标点），
 * 退回按字符数等比分配，宁可时间粗一点，也不要整条时间轴错位。
 */
function alignTime(fullText, cues){
  const norm = s => String(s || "").replace(/\s/g, "");
  const cueSeq = cues.map(c => ({ ...c, t: norm(c.text) }));
  const joined = cueSeq.map(c => c.t).join("");
  const target = norm(fullText);

  // 每条 cue 覆盖的字符区间（在拼接串坐标系里）
  let cur = 0;
  for (const c of cueSeq){ c.cs = cur; c.ce = cur + c.t.length; cur = c.ce; }

  const exact = joined === target;
  const n = exact ? target.length : joined.length;

  /** 字符位置 → 时间（pos 为「第 pos 个字符之前」的位置，0..n） */
  function timeAt(pos){
    const p = Math.max(0, Math.min(n, pos));
    for (const c of cueSeq){
      if (p <= c.ce){
        const span = Math.max(1, c.ce - c.cs);
        const r = Math.max(0, Math.min(1, (p - c.cs) / span));
        return Math.round(c.t0 + (c.t1 - c.t0) * r);
      }
    }
    return cueSeq.length ? cueSeq[cueSeq.length - 1].t1 : 0;
  }

  /** 字格：每个字符的起点时间，供切点吸附 */
  const charTimes = [];
  if (exact){
    for (let i = 0; i < target.length; i++) charTimes.push(timeAt(i));
  }
  return { exact, timeAt, charTimes, n };
}

/**
 * 整段合成。返回：
 *   { engine, mode:"whole", audio, items:[{i,text,t0,t1}], totalMs, charTimes, note }
 */
export async function synthesize(lines, opt = {}){
  const voice = opt.voice || DEFAULT_VOICE;
  const engine = await detectEngine();
  const note = [];

  if (engine === "none"){
    const items = [];
    let cursor = LEAD_MS;
    for (let i = 0; i < lines.length; i++){
      const d = estimateDuration(lines[i]);
      items.push({ i, text: lines[i], t0: cursor, t1: cursor + d });
      cursor += d + Math.max(0, Number(opt.gapMs ?? 160));
    }
    note.push("未检测到 edge-tts，本次成片无配音，仅保留字幕");
    return { engine, mode: "none", audio: null, items, totalMs: cursor + TAIL_MS, charTimes: [], note };
  }

  // 逐行合成：一行一句、句间留真实的停顿。
  // 整段合成时，行与行之间只有句号带来的 ~0.2s 间隙，连着念十几行听起来是一口气，
  // 跟「一行断一次」对不上。逐行合成能把停顿做到 0.35s 且可调。
  if (opt.perLine){
    const per = await synthesizePerLine(lines, {
      ...opt, voice,
      gapMs: Math.max(350, Number(opt.gapMs || 0) || 0)
    });
    return per;
  }

  const { text, spans } = buildWhole(lines, opt.wholeText);
  const speed = Number(opt.speed || 1);
  const pitch = opt.pitch || "";
  const key = sha1(`whole|${voice}|${speed}|${pitch}|${text}`);
  const media = path.join(CACHE, key + ".mp3");
  const sub = path.join(CACHE, key + ".srt");
  const txt = path.join(CACHE, key + ".txt");

  const exists = fs.existsSync(media) && fs.statSync(media).size > 500 && fs.existsSync(sub);
  if (!exists){
    fs.writeFileSync(txt, text, "utf8");
    const args = ["-f", txt, "-v", voice, "--write-media", media, "--write-subtitles", sub, "--no-progress"];
    const ra = rateArg(speed); if (ra) args.push(ra);
    const pa = pitchArg(pitch); if (pa) args.push(pa);

    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++){
      if (attempt) await new Promise(r => setTimeout(r, 2500));
      const r = await run(BIN.edgeTts, args, { timeout: 180000 });
      ok = r.code === 0 && fs.existsSync(media) && fs.statSync(media).size > 500 && fs.existsSync(sub);
      if (!ok && attempt === 2){
        note.push(`整段合成失败（${(r.err || "").split("\n").filter(Boolean).slice(-1)[0] || "未知原因"}），已退回逐句`);
      }
    }
  }

  if (fs.existsSync(media) && fs.existsSync(sub)){
    const cues = parseSrt(fs.readFileSync(sub, "utf8"));
    if (cues.length){
      const { exact, timeAt, charTimes } = alignTime(text, cues);
      if (!exact) note.push("词边界与原文未逐字对齐，时间按字符数等比回填");

      // 首句起点对齐到 lead；服务端一般给 0.1s 左右
      const rawFirst = timeAt(spans[0].ls);
      const shift = Math.max(0, LEAD_MS - rawFirst);

      const items = spans.map((s, i) => ({
        i,
        text: lines[i],
        t0: timeAt(s.ls) + shift,
        t1: timeAt(s.bodyEnd) + shift
      }));
      // 单调修正：服务端的句边界会有几十毫秒重叠，这里拉平
      for (let i = 1; i < items.length; i++){
        if (items[i].t0 < items[i - 1].t1) items[i].t0 = items[i - 1].t1;
        if (items[i].t1 <= items[i].t0) items[i].t1 = items[i].t0 + 300;
      }

      const totalMs = items[items.length - 1].t1 + TAIL_MS;
      return {
        engine, mode: "whole", audio: media, items, totalMs,
        charTimes: shift ? charTimes.map(t => t + shift) : charTimes,
        leadMs: shift, note
      };
    }
    note.push("词边界文件为空，已退回逐句");
  }

  /* ---------- 兜底：逐句合成（听感会「一句一句蹦」，交付前要说清楚） ---------- */
  const per = await synthesizePerLine(lines, { ...opt, voice });
  note.push(...per.note);
  return per;
}

async function synthesizePerLine(lines, opt = {}){
  const voice = opt.voice || DEFAULT_VOICE;
  const engine = await detectEngine();
  const items = [];
  const note = ["配音逐行合成：每行独立断句，行间留 0.35s 以上停顿"];

  const conc = Math.min(4, Math.max(1, opt.concurrency || 3));
  const queue = lines.map((text, i) => ({ text, i }));
  const done = [];
  const workers = Array.from({ length: conc }, () => worker());
  async function worker(){
    for (;;){
      const job = queue.shift();
      if (!job) return;
      const key = sha1(`${voice}|${opt.speed || 1}|${job.text}`);
      const cached = path.join(CACHE, key + ".mp3");
      let dur = 0;
      let file = cached;
      if (fs.existsSync(cached) && fs.statSync(cached).size > 500){
        const p = await probe(cached);
        if (p && p.duration > 0) dur = Math.round(p.duration * 1000);
      }
      if (!dur){
        const args = ["--voice", voice, "--text", job.text, "--write-media", cached, "--no-progress"];
        const ra = rateArg(opt.speed); if (ra) args.push(ra);
        const pa = pitchArg(opt.pitch); if (pa) args.push(pa);
        let r = await run(BIN.edgeTts, args, { timeout: 60000 });
        if (r.code !== 0 || !fs.existsSync(cached)) r = await run(BIN.edgeTts, args, { timeout: 60000 });
        if (r.code === 0 && fs.existsSync(cached)){
          const p = await probe(cached);
          if (p && p.duration > 0) dur = Math.round(p.duration * 1000);
        }
        if (!dur) note.push(`第 ${job.i + 1} 句合成失败`);
      }
      // edge-tts 每句 mp3 的尾巴上带约 1 秒静音。不裁掉的话，
      // 逐行拼接后句间空隙 = 1s + gap，实测变成 1.4s，像断了一半。
      if (dur){
        const tkey = path.join(CACHE, key + ".t.mp3");
        if (!fs.existsSync(tkey) || fs.statSync(tkey).size < 500){
          await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", cached,
            "-af", "areverse,silenceremove=start_periods=1:start_duration=0.06:start_threshold=-42dB:detection=peak,areverse",
            "-c:a", "libmp3lame", "-q:a", "4", tkey], { timeout: 60000 });
        }
        if (fs.existsSync(tkey) && fs.statSync(tkey).size > 500){
          const p2 = await probe(tkey);
          if (p2 && p2.duration > 0){ file = tkey; dur = Math.round(p2.duration * 1000); }
        }
      }
      done.push({ i: job.i, text: job.text, duration: dur || estimateDuration(job.text), file: fs.existsSync(file) ? file : null, ok: !!dur });
    }
  }
  await Promise.all(workers);
  done.sort((a, b) => a.i - b.i);

  let cursor = LEAD_MS;
  const gap = Math.max(0, Number(opt.gapMs ?? 160));
  for (const it of done){
    items.push({ i: it.i, text: it.text, t0: cursor, t1: cursor + it.duration, duration: it.duration, file: it.file });
    cursor += it.duration + gap;
  }
  return { engine, mode: "per-line", audio: null, items, totalMs: cursor + TAIL_MS, charTimes: [], note };
}
