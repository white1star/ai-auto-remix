/**
 * 通用工具：HTTP 收发、子进程、媒体探测。零第三方依赖。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/* ---------------- HTTP ---------------- */
export function sendJson(res, code, obj, headers){
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...(headers || {})
  });
  res.end(body);
}
export const ok = (res, obj, headers) => sendJson(res, 200, { ok: true, ...obj }, headers);
export const fail = (res, code, error) => sendJson(res, code, { ok: false, error });

export function sendText(res, code, text, type = "text/plain; charset=utf-8"){
  const body = Buffer.from(text);
  res.writeHead(code, { "Content-Type": type, "Content-Length": body.length });
  res.end(body);
}

export function readBody(req, limit = 512 * 1024 * 1024){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit){ reject(Object.assign(new Error("请求体过大"), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req, limit){
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); }
  catch(e){ throw Object.assign(new Error("JSON 解析失败"), { code: 400 }); }
}

/* ---------------- 子进程 ---------------- */
const BIN = {
  ffmpeg: process.env.FFMPEG || "ffmpeg",
  ffprobe: process.env.FFPROBE || "ffprobe",
  edgeTts: process.env.EDGE_TTS || "edge-tts"
};
export { BIN };

/** ffmpeg 需要 fontconfig 才能找到 SimHei / 微软雅黑，统一注入 */
const FONTS_CONF = path.join(path.dirname(fileURLToPath(import.meta.url)), "fonts.conf");
const ENV = {
  ...process.env,
  ...(fs.existsSync(FONTS_CONF) ? { FONTCONFIG_FILE: FONTS_CONF } : {})
};

export function run(bin, args, opts = {}){
  return new Promise(resolve => {
    let out = "", err = "";
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, env: ENV, ...opts });
    } catch(e){
      return resolve({ code: -1, out: "", err: String(e.message) });
    }
    const timer = opts.timeout ? setTimeout(() => { try { child.kill("SIGKILL"); } catch(e){} }, opts.timeout) : null;
    child.stdout?.on("data", d => { out += d; if (out.length > 400000) out = out.slice(-200000); });
    child.stderr?.on("data", d => { err += d; if (err.length > 400000) err = err.slice(-200000); });
    child.on("error", e => { if (timer) clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
    child.on("close", code => { if (timer) clearTimeout(timer); resolve({ code, out, err }); });
    if (opts.stdin){
      try { child.stdin.end(opts.stdin); } catch(e){}
    }
  });
}

/* ---------------- 媒体探测 ---------------- */
export async function probe(file){
  const r = await run(BIN.ffprobe, [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", file
  ]);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.out);
    const v = (j.streams || []).find(s => s.codec_type === "video");
    const a = (j.streams || []).find(s => s.codec_type === "audio");
    return {
      duration: +(j.format?.duration || v?.duration || 0),
      width: v?.width || 0, height: v?.height || 0,
      vcodec: v?.codec_name || null, acodec: a?.codec_name || null,
      hasVideo: !!v, hasAudio: !!a,
      fps: v?.avg_frame_rate ? evalFps(v.avg_frame_rate) : 0
    };
  } catch(e){ return null; }
}
function evalFps(s){
  const [a, b] = String(s).split("/").map(Number);
  return b ? +(a / b).toFixed(2) : (a || 0);
}

/* ---------------- 文件 ---------------- */
export const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
export const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
export const MEDIA_EXT = new Set([...VIDEO_EXT, ...IMAGE_EXT]);

export function extOf(name){ return path.extname(String(name || "")).toLowerCase(); }
export const isMedia = name => MEDIA_EXT.has(extOf(name));

/** 去掉路径分隔符与 .. ，保留中文 */
export function safeName(name){
  return String(name || "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\.{2,}/g, ".")
    .trim().slice(0, 120) || "file";
}

export function uniqName(dir, name){
  const base = safeName(name);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let cand = base, i = 1;
  while (fs.existsSync(path.join(dir, cand))) cand = `${stem}_${i++}${ext}`;
  return cand;
}

/** 判断 child 是否位于 parent 内（防目录穿越） */
export function inside(parent, child){
  const p = path.resolve(parent).toLowerCase();
  const c = path.resolve(child).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

export const sha1 = s => crypto.createHash("sha1").update(s).digest("hex");
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const fmtTime = ms => {
  const s = Math.max(0, ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
};
export const fmtSrtTime = ms => fmtTime(ms).replace(".", ",");

/* ---------------- ASS 字幕 ---------------- */
export function toAss(cues, opt = {}){
  const font = opt.font || "SimHei";
  const size = opt.size || 64;
  const maxChars = opt.maxChars || 16;
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Def,${font},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,1,0,1,4,2,2,60,60,220,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = cues.map(c => {
    const txt = wrap(String(c.text || "").trim(), maxChars)
      .replace(/\{/g, "（").replace(/\}/g, "）")
      .replace(/\r?\n/g, "\\N");
    return `Dialogue: 0,${fmtTime(c.start)},${fmtTime(c.end)},Def,,0,0,0,,${txt}`;
  });
  return head + lines.join("\n") + "\n";
}

function wrap(s, n){
  if (!s) return "";
  // 按标点优先断行，其次按字数硬切
  const parts = s.split(/(?<=[，。！？；：、,.!?;:])/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const p of parts){
    if ((cur + p).length <= n) { cur += p; continue; }
    if (cur) out.push(cur);
    if (p.length <= n) cur = p;
    else {
      for (let i = 0; i < p.length; i += n) out.push(p.slice(i, i + n));
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out.join("\n");
}

/* ---------------- SRT ---------------- */
export function toSrt(cues){
  return cues.map((c, i) =>
    `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${String(c.text || "").trim()}\n`
  ).join("\n");
}
