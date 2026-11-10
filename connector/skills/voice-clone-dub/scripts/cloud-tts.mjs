/**
 * 云端 TTS 批量合成（接口对齐 gsv-tts.py / clone-tts.py，供 server/clone.mjs 调用）。
 *
 * 为什么加这一层：本地克隆（F5 / GPT-SoVITS）出来的音色始终和原片有差距，
 * 要么上云端预设音色（edge，免费、永不漏字、但不像原片），
 * 要么上云厂商的「声音复刻」（能贴原片音色，按量计费、需要凭证）。
 * 两条路对外接口一样，所以这里做成 provider 结构，上层管线一套代码。
 *
 * provider：
 *   edge     微软 Edge 神经音色，随包带 runtime/edge-tts，免 key，逐句秒级
 *   volc     火山引擎豆包语音：声音复刻 + TTS（需 VOLC_APPID / VOLC_TOKEN / VOLC_CLUSTER）
 *   tencent  腾讯云 VRS 声音复刻（需 TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_APPID）
 *   aliyun   阿里云 CosyVoice 声音复刻（需 ALIYUN_KEY_ID / ALIYUN_KEY_SECRET）
 *
 * 输出（机器可读，clone.mjs 靠这行拿时长）：
 *   SEG <i> <总时长> <字数> <本段耗时> <有效语音时长>
 *   BATCH OK <段数>
 *
 * 用法：
 *   node cloud-tts.mjs --provider edge --voice zh-CN-YunjianNeural \
 *        --gen-list lines.txt --out-dir out [--speed 1.0] [--speed-list sp.txt]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const arg = (name, def = "") => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const PROVIDER = (arg("provider", process.env.CLOUD_PROVIDER || "edge")).toLowerCase();

/* 凭证：优先环境变量；没有就读用户目录里的私有配置（绝不随项目包分发）。
   新版控制台只要一个 API Key（UUID 格式），旧版才是 APP ID + Access Token。 */
const KEY_FILE = path.join(os.homedir(), ".workbuddy", "voices", ".cloud-key.json");
function credentials(){
  let c = {};
  try { c = JSON.parse(fs.readFileSync(KEY_FILE, "utf8")); } catch(e){}
  const pick = (k, f) => process.env[k] || c[k] || f || "";
  return {
    apiKey: pick("VOLC_API_KEY"),
    appId: pick("VOLC_APPID"),
    token: pick("VOLC_TOKEN"),
    resourceId: pick("VOLC_RESOURCE_ID"),
    speaker: pick("CLOUD_SPEAKER")
  };
}
const CRED = credentials();

let VOICE = arg("voice", process.env.CLOUD_VOICE || "");
if (!VOICE) VOICE = PROVIDER === "volc" ? "zh_male_m191_uranus_bigtts" : "zh-CN-YunjianNeural";
const GEN_LIST = arg("gen-list");
const OUT_DIR = arg("out-dir");
const SPEED = Number(arg("speed", "1"));
const SPEED_LIST = arg("speed-list");
const REF = arg("ref", "");            // 复刻类 provider 用：干净人声片段
const REF_TEXT = arg("ref-text", "");
const SPEAKER = arg("speaker", process.env.CLOUD_SPEAKER || ""); // 复刻后拿到的音色 ID

if (!GEN_LIST || !OUT_DIR){
  console.error("用法: node cloud-tts.mjs --provider edge --voice <id> --gen-list <txt> --out-dir <dir> [--speed 1.0]");
  process.exit(2);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------------- 找可执行文件 ---------------- */
function upward(rel, levels = 8){
  let cur = HERE;
  for (let i = 0; i < levels; i++){
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
    const c = path.join(cur, rel);
    if (fs.existsSync(c)) return c;
  }
  return null;
}
const EXE = process.platform === "win32" ? ".exe" : "";
const FFMPEG = process.env.FFMPEG || upward("runtime/ffmpeg" + EXE) || "ffmpeg";
const FFPROBE = process.env.FFPROBE || upward("runtime/ffprobe" + EXE) || "ffprobe";
const EDGE = process.env.EDGE_TTS || upward("runtime/edge-tts/edge-tts" + EXE) || "edge-tts";

function sh(bin, args, opt = {}){
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(opt.env || {}) } });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}
function durOf(p){
  const r = sh(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]);
  const v = parseFloat(String(r.out).trim());
  return Number.isFinite(v) ? v : 0;
}

/** 有效语音时长：掐掉首尾静音。语速要按这个算，不然边缘静音会把 7 字/秒摊成 5 字/秒 */
function speechLen(p, total){
  const r = sh(FFMPEG, ["-hide_banner", "-nostats", "-i", p, "-af",
    "silencedetect=noise=-45dB:d=0.02", "-f", "null", "-"]);
  const txt = String(r.err || "");
  const starts = [...txt.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map(m => +m[1]);
  const ends = [...txt.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => +m[1]);
  let head = 0, tail = 0;
  if (starts.length && starts[0] <= 0.02) head = ends.length ? ends[0] : 0;
  if (starts.length && ends.length < starts.length) tail = total - starts[starts.length - 1];
  const sp = total - head - tail;
  return sp > 0.05 ? sp : total;
}

/* ---------------- 文本 ---------------- */
let lines = fs.readFileSync(GEN_LIST, "utf8").split(/\r?\n/)
  .map(s => s.replace(/\u200b/g, "").trim()).filter(Boolean);
let speeds = [];
if (SPEED_LIST && fs.existsSync(SPEED_LIST)){
  speeds = fs.readFileSync(SPEED_LIST, "utf8").split(/\r?\n/)
    .map(x => (x.trim() ? Number(x) : SPEED));
}
const speedOf = i => (i < speeds.length && Number.isFinite(speeds[i]) ? speeds[i] : SPEED);
if (!lines.length){ console.error("文案为空"); process.exit(2); }

/* ---------------- provider: edge ---------------- */
// edge 的语速是百分比（--rate=+25%），不是倍数。中文默认约 4.0 字/秒，
// 目标 5 字/秒大概要 +20%，所以按 (speed-1)*100 映射，剩下的交给上层的逐句 atempo。
function edgeOne(i, text, outWav){
  const spd = speedOf(i);
  const pct = Math.round((spd - 1) * 100);
  const txt = path.join(OUT_DIR, `_t${i}.txt`);
  const mp3 = path.join(OUT_DIR, `_t${i}.mp3`);
  // 句尾没标点会被念得很赶，补一个；去掉百分号加号这种会被读成「百分之四十加」的组合
  let say = /[。！？!?…，,；;：:]$/.test(text) ? text : text + "。";
  say = say.replace(/[%％]\s*\+/g, "％以上");
  fs.writeFileSync(txt, say, "utf8");
  const args = ["-f", txt, "-v", VOICE, "--write-media", mp3, "--no-progress"];
  if (pct) args.push(`--rate=${pct > 0 ? "+" : ""}${pct}%`);
  let last = "";
  for (let k = 0; k < 3; k++){
    if (k) spawnSync(process.platform === "win32" ? "ping" : "sleep",
      process.platform === "win32" ? ["-n", "3", "127.0.0.1"] : ["2"]);
    const r = sh(EDGE, args);
    if (r.code === 0 && fs.existsSync(mp3) && fs.statSync(mp3).size > 1500){ last = ""; break; }
    last = ((r.err || "") + (r.out || "")).trim().split("\n").slice(-3).join(" | ");
  }
  if (last) throw new Error("edge-tts 合成失败：" + last);
  const c = sh(FFMPEG, ["-y", "-loglevel", "error", "-i", mp3,
    "-ar", "32000", "-ac", "1", "-c:a", "pcm_s16le", outWav]);
  try { fs.unlinkSync(mp3); fs.unlinkSync(txt); } catch(e){}
  if (c.code !== 0) throw new Error("转 wav 失败：" + (c.err || "").trim().split("\n").slice(-2).join(" | "));
}

/* ---------------- provider: 云厂商复刻 ---------------- */
// 三家都是「先复刻训练出一个音色 ID，再用这个 ID 合成」。训练是异步的，
// 一次几秒到几十秒，所以不在逐句合成里做，交给 ensureSpeaker() 单独跑一次。
function needEnv(keys){
  const miss = keys.filter(k => !process.env[k]);
  if (miss.length) throw new Error(`用 ${PROVIDER} 需要先设环境变量：${miss.join(" / ")}`);
}

function volcSynthesize(i, text, outWav){
  // 新版控制台（豆包语音 2.0）：单个 X-Api-Key 就能鉴权，不需要 APPID。
  // 之前拿 APPID + Token 走旧版头，所有接口都返回 45000010「grant not found」——
  // 不是服务没开通，是鉴权体系和控制台版本对不上。
  // 资源 ID 也分代：2.0 预置音色用 seed-tts-2.0，复刻音色用 seed-icl-2.0，
  // 老 ID（volc.service_type.* / seed-icl-1.0）在这个账号上全部不可用。
  const spk = CRED.speaker || SPEAKER;
  const rid = CRED.resourceId || (spk && spk.startsWith("S_") ? "seed-icl-2.0" : "seed-tts-2.0");
  const headers = ["-H", "Content-Type: application/json", "-H", "X-Api-Resource-Id: " + rid,
                   "-H", "X-Api-Request-Id: " + (globalThis.crypto?.randomUUID?.() || `seg-${i}-${Date.now()}`)];
  if (CRED.apiKey){
    headers.push("-H", "X-Api-Key: " + CRED.apiKey);
  } else if (CRED.appId && CRED.token){
    headers.push("-H", "X-Api-App-Id: " + CRED.appId,
                 "-H", "X-Api-Access-Key: " + CRED.token);
  } else {
    throw new Error(`缺火山凭证：设 VOLC_API_KEY，或写到 ${KEY_FILE}`);
  }
  const body = {
    user: { uid: process.env.VOLC_UID || "remix" },
    req_params: {
      text,
      speaker: spk || VOICE,
      audio_params: {
        format: "wav",
        sample_rate: Number(process.env.VOLC_SR || 24000),
        // speech_rate 是百分比整数 [-50, 100]，100 才是 2 倍速
        speech_rate: Math.round((speedOf(i) - 1) * 100)
      }
    }
  };
  const r = sh("curl", ["-s", "-X", "POST", "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    ...headers, "-d", JSON.stringify(body)]);
  // HTTP Chunked 流：每行一个 JSON，音频分片在顶层 data 里（不是 header.data）。
  // code=0 是音频片，code=20000000 是正常结束，其余都是错误。
  let buf = Buffer.alloc(0), err = "";
  for (const ln of String(r.out || "").split(/\r?\n/)){
    const t = ln.trim();
    if (!t.startsWith("{")) continue;
    let j;
    try { j = JSON.parse(t); } catch(e){ continue; }
    if (j.data) buf = Buffer.concat([buf, Buffer.from(j.data, "base64")]);
    if (j.code && j.code !== 0 && j.code !== 20000000) err = `${j.code} ${j.message || ""}`;
  }
  if (!buf.length) throw new Error(`火山合成失败：${err || String(r.out).slice(0, 200)}`);
  fs.writeFileSync(outWav, buf);
}

const PROVIDERS = {
  edge: edgeOne,
  volc: volcSynthesize,
  tencent: () => { needEnv(["TENCENT_SECRET_ID", "TENCENT_SECRET_KEY", "TENCENT_APPID"]);
    throw new Error("腾讯云 VRS 适配还没接完（签名是 TC3-HMAC-SHA256，等确认 AppId 再补）"); },
  aliyun: () => { needEnv(["ALIYUN_KEY_ID", "ALIYUN_KEY_SECRET"]);
    throw new Error("阿里云 CosyVoice 适配还没接完（WebSocket 流式接口，等确认音色 ID 再补）"); }
};
const synthOne = PROVIDERS[PROVIDER];
if (!synthOne){
  console.error(`不认识的 provider：${PROVIDER}（可选 ${Object.keys(PROVIDERS).join(" / ")}）`);
  process.exit(2);
}

/* ---------------- 主循环 ---------------- */
let ok = 0;
for (let i = 0; i < lines.length; i++){
  const t0 = Date.now();
  const out = path.join(OUT_DIR, `seg_${String(i).padStart(2, "0")}.wav`);
  try {
    synthOne(i, lines[i], out);
  } catch(e){
    console.error(`SEG ${i} 0 0 ${((Date.now() - t0) / 1000).toFixed(1)} 0`);
    console.error("  第 " + (i + 1) + " 句合成失败：" + e.message);
    continue;
  }
  const total = durOf(out);
  const sp = speechLen(out, total);
  ok++;
  console.log(`SEG ${i} ${total.toFixed(3)} ${lines[i].length} ${((Date.now() - t0) / 1000).toFixed(1)} ${sp.toFixed(3)}`);
}
console.log(`BATCH OK ${ok} 段`);
if (!ok) process.exit(1);
