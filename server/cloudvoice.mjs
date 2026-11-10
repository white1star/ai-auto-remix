/**
 * 网页云端配音 —— 把 connector/skills/voice-clone-dub/scripts/cloud-tts.mjs 接进网页生成链路。
 *
 * 为什么单独一层：
 *   server/tts.mjs 是随包 edge-tts 的「系统音色」，只认 zh-CN-* ；
 *   server/clone.mjs 是本机 F5 / GPT-SoVITS 的「克隆音色」，要装 1.4GB 权重。
 *   这次跑通的是火山豆包语音 2.0（新版控制台 X-Api-Key + seed-tts-2.0），
 *   它既不是系统音色也不依赖本机权重，于是新增这条通道，网页选中就走这里。
 *
 * 输出结构与 tts.mjs 的 synthesize() 完全一致
 *   { engine:"cloud", mode:"per-line", audio:null, items:[{i,text,t0,t1,duration,file}], ... }
 * 所以 render.mjs 里的时间轴、分镜、字幕、BGM、buildNarration 一行都不用改。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DIRS } from "./db.mjs";
import { run, probe, sha1, BIN } from "./util.mjs";
import { LEAD_MS, TAIL_MS } from "./tts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "connector", "skills", "voice-clone-dub", "scripts", "cloud-tts.mjs");
const KEY_FILE = path.join(os.homedir(), ".workbuddy", "voices", ".cloud-key.json");
const PREVIEW_DIR = path.join(DIRS.audio, "cloud-preview");
const WORK_ROOT = path.join(DIRS.runs, "cloud-tts");
for (const d of [PREVIEW_DIR, WORK_ROOT]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch(e){}
}

/** 句间停顿：沿用已验收的云端 8 行成片口径（0.45s），别改回 160ms，否则连着念 */
export const CLOUD_GAP_MS = 450;
/** 裁尾：只留 30ms 静音。start_duration=0.12 会多削 0.12s，把「吗」「线」等尾字吞掉。 */
const TRIM_TAIL = "areverse,silenceremove=start_periods=1:start_silence=0.03:start_threshold=-45dB:detection=peak,areverse";

/**
 * 音色清单。volc 组是火山「豆包语音合成模型 2.0」官方 voice_type，
 * 资源 ID 用 seed-tts-2.0；edge 组是随包带的免费音色，没配 key 时兜底。
 * 只列实测能返回音频的，没验过的不要往里加。
 */
export const CLOUD_VOICES = [
  { id: "zh_male_m191_uranus_bigtts",        name: "云舟 2.0 · 男声 · 沉稳", provider: "volc", group: "云端音色 · 火山豆包 2.0" },
  { id: "zh_male_taocheng_uranus_bigtts",    name: "小天 2.0 · 男声 · 磁性", provider: "volc", group: "云端音色 · 火山豆包 2.0" },
  { id: "zh_male_liufei_uranus_bigtts",      name: "刘飞 2.0 · 男声 · 播报", provider: "volc", group: "云端音色 · 火山豆包 2.0" },
  { id: "zh_male_jieshuoxiaoming_uranus_bigtts", name: "解说小明 2.0 · 男声", provider: "volc", group: "云端音色 · 火山豆包 2.0" },
  { id: "zh_male_cixingjieshuonan_uranus_bigtts", name: "磁性解说男声 2.0", provider: "volc", group: "云端音色 · 火山豆包 2.0" },
  { id: "zh_male_dayi_uranus_bigtts",        name: "大壹 2.0 · 男声 · 视频配音", provider: "volc", group: "云端音色 · 火山豆包 2.0" },
  { id: "zh_female_vv_uranus_bigtts",        name: "Vivi 2.0 · 女声", provider: "volc", group: "云端音色 · 火山豆包 2.0" },
  { id: "zh_female_xiaohe_uranus_bigtts",    name: "小何 2.0 · 女声", provider: "volc", group: "云端音色 · 火山豆包 2.0" },
  { id: "zh_female_qingxinnvsheng_uranus_bigtts", name: "清新女声 2.0", provider: "volc", group: "云端音色 · 火山豆包 2.0" },
  { id: "zh-CN-YunjianNeural",  name: "云健 · 男声 · 浑厚（免费）", provider: "edge", group: "免费备用 · 不配 key 也能用" },
  { id: "zh-CN-YunyangNeural", name: "云扬 · 男声 · 播报（免费）", provider: "edge", group: "免费备用 · 不配 key 也能用" },
  { id: "zh-CN-YunxiNeural",   name: "云希 · 男声 · 年轻（免费）", provider: "edge", group: "免费备用 · 不配 key 也能用" },
  { id: "zh-CN-XiaoxiaoNeural",name: "晓晓 · 女声 · 亲和（免费）", provider: "edge", group: "免费备用 · 不配 key 也能用" }
];
export const DEFAULT_CLOUD_VOICE = "zh_male_m191_uranus_bigtts";

/** 凭证只在用户目录，绝不随「给同事」项目包分发；不回传给前端 */
export function cloudCredentials(){
  let c = {};
  try { c = JSON.parse(fs.readFileSync(KEY_FILE, "utf8")); } catch(e){}
  const pick = k => process.env[k] || c[k] || "";
  return {
    apiKey: pick("VOLC_API_KEY"),
    appId: pick("VOLC_APPID"),
    token: pick("VOLC_TOKEN"),
    resourceId: pick("VOLC_RESOURCE_ID"),
    speaker: pick("CLOUD_SPEAKER")
  };
}

/** 云端通道当前状态：有没有凭证、走哪家、能选哪些音色 */
export function cloudStatus(){
  const c = cloudCredentials();
  const volcReady = !!(c.apiKey || (c.appId && c.token));
  const envProvider = String(process.env.CLOUD_PROVIDER || "").toLowerCase();
  const provider = (envProvider === "volc" || envProvider === "edge")
    ? envProvider
    : (volcReady ? "volc" : "edge");
  const edgeOk = !!(process.env.EDGE_TTS || fs.existsSync(path.join(ROOT, "runtime", "edge-tts",
    process.platform === "win32" ? "edge-tts.exe" : "edge-tts")));
  const ready = provider === "volc" ? volcReady : edgeOk;
  const missing = [];
  if (provider === "volc" && !volcReady)
    missing.push(`火山凭证（把 X-Api-Key 写到 ${KEY_FILE} 的 VOLC_API_KEY）`);
  if (provider === "edge" && !edgeOk) missing.push("runtime/edge-tts/edge-tts.exe");
  const voices = CLOUD_VOICES.filter(v => v.provider === provider);
  const defaultVoice = voices.some(v => v.id === DEFAULT_CLOUD_VOICE)
    ? DEFAULT_CLOUD_VOICE : (voices[0]?.id || "");
  return {
    ready, provider, missing, voices, defaultVoice, edgeOk,
    speaker: c.speaker || "",
    keyFile: KEY_FILE,
    // 复刻音色一旦在用户目录配好，cloud-tts.mjs 会优先用它，下拉里的预置音色会被覆盖
    locked: !!c.speaker,
    charged: provider === "volc"
  };
}

export function findCloudVoice(id){
  const v = String(id || "").trim();
  return CLOUD_VOICES.find(x => x.id === v) || null;
}

/** 调 cloud-tts.mjs，返回 { outDir, segs:[{i,dur,speech}] } */
async function batch(lines, { provider, voice, speaker, speed, workDir }){
  const listFile = path.join(workDir, "lines.txt");
  const outDir = path.join(workDir, "wav");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(listFile, lines.map(s => String(s).replace(/[\r\n]/g, " ")).join("\n"), "utf8");
  const args = [SCRIPT,
    "--provider", provider,
    "--voice", voice,
    "--gen-list", listFile,
    "--out-dir", outDir,
    "--speed", String(speed)];
  if (speaker) args.push("--speaker", speaker);
  const r = await run(process.execPath, args, {
    timeout: Math.max(180000, lines.length * 30000),
    env: { ...process.env, CLOUD_PROVIDER: provider }
  });
  const segs = [];
  for (const ln of String(r.out || "").split(/\r?\n/)){
    const m = /^SEG\s+(\d+)\s+([\d.]+)\s+\d+\s+[\d.]+\s+([\d.]+)/.exec(ln.trim());
    if (m) segs[+m[1]] = { i: +m[1], dur: +m[2], speech: +m[3] };
  }
  return { outDir, segs, code: r.code, err: String(r.err || "") };
}

/** 每段裁掉尾部长静音（不吞尾字），再统一取真实时长 */
async function shape(raw, out){
  const r = await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error",
    "-i", raw, "-af", TRIM_TAIL, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", out],
    { timeout: 60000 });
  return r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 500;
}

/**
 * 给 render.mjs 用：云端逐句合成，产出时间轴。
 * 与 synthesizePerLine 同结构，buildNarration 会按 items[].file 拼接成 vo.wav。
 */
export async function synthesizeCloud(lines, opt = {}){
  const st = cloudStatus();
  if (!st.ready) throw Object.assign(new Error("云端配音不可用：" + st.missing.join("；")), { code: 409 });
  const voice = findCloudVoice(opt.voice)?.provider === st.provider
    ? opt.voice : st.defaultVoice;
  const speed = Math.min(2, Math.max(0.5, Number(opt.speed || 1)));
  const gap = Math.max(350, Number(opt.gapMs || CLOUD_GAP_MS));
  const key = sha1(`cloud|${st.provider}|${voice}|${st.speaker}|${speed}|${lines.join("\n")}`);
  const workDir = opt.workDir || path.join(WORK_ROOT, key);
  fs.mkdirSync(workDir, { recursive: true });

  const { outDir, segs, code, err } = await batch(lines, {
    provider: st.provider, voice, speaker: st.speaker, speed, workDir
  });
  if (code !== 0 && !segs.some(Boolean))
    throw new Error(`云端合成没出音频：${err.split("\n").filter(Boolean).slice(-2).join(" | ")}`);

  const items = [];
  const note = [`云端配音：${st.provider === "volc" ? "火山豆包语音 2.0" : "edge 免费音色"} · ${voice} · ${speed.toFixed(2)}×`];
  let cursor = LEAD_MS;
  for (let i = 0; i < lines.length; i++){
    const raw = path.join(outDir, `seg_${String(i).padStart(2, "0")}.wav`);
    if (!fs.existsSync(raw) || fs.statSync(raw).size < 500){
      note.push(`第 ${i + 1} 句云端合成失败，用估算时长占位`);
      const d = Math.max(600, Math.round(lines[i].length / 4.5 / speed * 1000));
      items.push({ i, text: lines[i], t0: cursor, t1: cursor + d, duration: d, file: null });
      cursor += d + gap;
      continue;
    }
    const shaped = path.join(outDir, `v_${String(i).padStart(2, "0")}.wav`);
    const file = await shape(raw, shaped) ? shaped : raw;
    const p = await probe(file);
    const d = Math.max(200, Math.round((p?.duration || segs[i]?.dur || 1) * 1000));
    items.push({ i, text: lines[i], t0: cursor, t1: cursor + d, duration: d, file });
    cursor += d + gap;
  }
  return {
    engine: "cloud", mode: "per-line", audio: null, items,
    totalMs: cursor + TAIL_MS, charTimes: items.map(it => it.t0), leadMs: 0,
    note
  };
}

/**
 * 效果试听：一句话，按音色+语速缓存，避免重复调云端计费接口。
 * 下拉里选了系统音色（zh-CN-*）时也能试听 —— 那就走随包 edge，不花云端的钱。
 */
export async function renderCloudPreview(text, voice, speed){
  const st = cloudStatus();
  const v0 = String(voice || "").trim();
  const wantEdge = /^zh-CN-/i.test(v0) || findCloudVoice(v0)?.provider === "edge";
  const provider = wantEdge ? "edge" : st.provider;
  if (wantEdge ? !st.edgeOk : !st.ready)
    throw Object.assign(new Error("试听不可用：" +
      (wantEdge ? "缺 runtime/edge-tts" : st.missing.join("；"))), { code: 409 });
  const say = String(text || "").trim().slice(0, 60) || "矿没选出来，人先破产了。";
  const v = wantEdge ? (v0 || "zh-CN-YunjianNeural")
    : (findCloudVoice(v0)?.provider === provider ? v0 : st.defaultVoice);
  const speaker = wantEdge ? "" : st.speaker;
  const spd = Math.min(2, Math.max(0.5, Number(speed || 1)));
  const id = sha1(`preview|${provider}|${v}|${speaker}|${spd}|${say}`);
  const out = path.join(PREVIEW_DIR, id + ".wav");
  if (fs.existsSync(out) && fs.statSync(out).size > 500) return { id, url: "/api/cloud/preview?id=" + id, cached: true };

  const workDir = path.join(WORK_ROOT, "preview-" + id);
  const { outDir, code, err } = await batch([say], {
    provider, voice: v, speaker, speed: spd, workDir
  });
  const raw = path.join(outDir, "seg_00.wav");
  if (!fs.existsSync(raw) || fs.statSync(raw).size < 500)
    throw new Error("试听合成失败：" + (err.split("\n").filter(Boolean).slice(-1)[0] || `退出码 ${code}`));
  const okShape = await shape(raw, out);
  if (!okShape) fs.copyFileSync(raw, out);
  return { id, url: "/api/cloud/preview?id=" + id, cached: false };
}

/** GET /api/cloud/preview 只认自己目录里的哈希文件名，不给路径穿越的机会 */
export function previewFile(id){
  const key = String(id || "");
  if (!/^[0-9a-f]{16,64}$/.test(key)) return null;
  const f = path.join(PREVIEW_DIR, key + ".wav");
  return fs.existsSync(f) ? f : null;
}
