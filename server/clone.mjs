/**
 * 本机克隆配音引擎 —— 服务端直接跑 F5，不经 WorkBuddy、不经 MCP、不用派单。
 *
 * 网站点「生成视频」时如果选了克隆音色，走这里：
 *   音色档案（ref.wav + ref.txt + bgm.mp3）→ 分段 → 逐段 F5 合成 → 拼音质检重渲
 *   → 段间插 300ms 停顿 → 拼成 vo.wav，BGM 直接从档案里拿。
 *
 * 产出跟「用户自己传配音」完全一样，所以 render.mjs 那边按 useVoFile 同一条路消费。
 *
 * 脚本不重写：直接调用 connector/skills/voice-clone-dub/scripts/ 下那套已验证的实现，
 * 免得同一件事维护两份。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { DIRS } from "./db.mjs";
import { BIN, probe } from "./util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_SC = path.join(ROOT, "connector", "skills", "voice-clone-dub", "scripts");
const SEG_MAX = Number(process.env.SEG_MAX || 60);
const QC_MIN = Number(process.env.QC_MIN || 0.96);
const QC_HEAD = Number(process.env.QC_HEAD || 0.9);
// 「多念」上限：F5 偶尔在句尾重复半句（叠字），覆盖率照样 0.98，只有这个指标能看出来
const QC_EXTRA = Number(process.env.QC_EXTRA || 0.16);
const QC_TRIES = Number(process.env.QC_TRIES || 3);
// 采样步数。F5 官方默认 32，实测 16 听不出差别、时间省一半；12 更快，
// 但个别长句会糊，所以默认 16，要更快的机器上可以设 CLONE_NFE=12。
const CLONE_NFE = Number(process.env.CLONE_NFE || 16);

/* ---------------- 环境：Python 与 F5 权重 ---------------- */

const WIN_PY312 = path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe");
const WIN_PY313 = path.join(os.homedir(), ".workbuddy", "binaries", "python", "versions", "3.13.12", "python.exe");

function firstExe(cands){
  for (const c of cands){
    if (!c) continue;
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch(e){}
  }
  return null;
}

/** 装 f5-tts / torch 的解释器 */
export function pyTts(){
  return firstExe([process.env.PY312, path.join(ROOT, "runtime", "python312", "python.exe"), WIN_PY312]);
}
/** 装 faster-whisper / pypinyin 的解释器 */
export function pyQc(){
  return firstExe([process.env.PY313, path.join(ROOT, "runtime", "python313", "python.exe"), WIN_PY313]);
}

/** F5 权重：F5_HOME → 包根 weights/f5 → 本机常见位置 */
export function f5Home(){
  const ok = d => fs.existsSync(path.join(d, "model_1250000.safetensors")) && fs.existsSync(path.join(d, "vocab.txt"));
  const cand = [];
  if (process.env.F5_HOME) cand.push(process.env.F5_HOME);
  cand.push(path.join(ROOT, "weights", "f5"));
  for (const base of [path.join(os.homedir(), "WorkBuddy"), path.join(os.homedir(), "Desktop")]){
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch(e){ continue; }
    for (const d of dirs){
      cand.push(path.join(base, d, "ai-auto-remix", ".workbuddy", "clone", "f5"));
      cand.push(path.join(base, d, "weights", "f5"));
    }
  }
  return cand.find(ok) || null;
}

/* ---------------- 引擎选择 ----------------
   f5  ：原来的 F5-TTS。它把参考音频当「上文」往下续写，每段开头必然把参考音频
         最后一个字再念一遍（本项目参考音频结尾是「…85%以上」，于是每段开头先冒「上」）。
         这个毛病在模型架构里，改参考音频、patch 预处理、按时间戳裁都堵不住。
   gsv ：GPT-SoVITS。参考音频只用来抽音色语义 token，输出第一个 token 就是目标文本
         第一个字，参考音频的尾字根本不在生成路径上。**默认用这个。**
   两个脚本接口一致（--ref / --ref-text / --gen-list / --speed-list），
   所以上层逻辑能共用，只有「漏字」相关的修补代码只在 f5 分支里跑。 */
/* 云端凭证：放用户目录，不随项目包分发（这个包名是「给同事」的，密钥不能进去）。
   环境变量优先，其次读 ~/.workbuddy/voices/.cloud-key.json。 */
const CLOUD_KEY_FILE = path.join(os.homedir(), ".workbuddy", "voices", ".cloud-key.json");
try {
  const ck = JSON.parse(fs.readFileSync(CLOUD_KEY_FILE, "utf8"));
  for (const k of ["VOLC_API_KEY", "VOLC_APPID", "VOLC_TOKEN", "VOLC_RESOURCE_ID", "CLOUD_SPEAKER"]){
    if (!process.env[k] && ck[k]) process.env[k] = ck[k];
  }
} catch(e){}

const ENGINE = /^(cloud|edge|volc|tencent|aliyun)$/i.test(String(process.env.CLONE_ENGINE || "")) ? "cloud"
  : /^(gsv|gpt-sovits)$/i.test(String(process.env.CLONE_ENGINE || "")) ? "gsv"
  : /^f5$/i.test(String(process.env.CLONE_ENGINE || "")) ? "f5"
  : "gsv";                       // 没指定就走 gsv；不可用时逐级退回（见 engineNow）

/** 云端 provider：edge 随包带、免 key；其余三家要凭证，见 cloud-tts.mjs */
const CLOUD_PROVIDER = String(process.env.CLOUD_PROVIDER || "edge").toLowerCase();
const CLOUD_VOICE = process.env.CLOUD_VOICE ||
  (CLOUD_PROVIDER === "volc" ? "zh_male_m191_uranus_bigtts" : "zh-CN-YunjianNeural");
const CLOUD_SPEAKER = process.env.CLOUD_SPEAKER || "";   // 复刻训练出来的音色 ID

/** 随包带的 edge-tts 可执行文件 */
export function edgeBin(){
  const n = process.platform === "win32" ? "edge-tts.exe" : "edge-tts";
  return firstExe([process.env.EDGE_TTS,
    path.join(ROOT, "runtime", "edge-tts", n),
    path.join(ROOT, "..", "runtime", "edge-tts", n)]);
}

/** GPT-SoVITS 源码目录：GSV_HOME → 包根 weights/gpt-sovits → 本机常见位置 */
export function gsvHome(){
  const ok = d => fs.existsSync(path.join(d, "GPT_SoVITS", "TTS_infer_pack", "TTS.py"));
  const cand = [];
  if (process.env.GSV_HOME) cand.push(process.env.GSV_HOME);
  cand.push(path.join(ROOT, "weights", "gpt-sovits"));
  for (const base of [path.join(os.homedir(), "WorkBuddy"), path.join(os.homedir(), "Desktop")]){
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch(e){ continue; }
    for (const d of dirs){
      const c = path.join(base, d, "ai-auto-remix", ".workbuddy", "clone");
      cand.push(path.join(c, "gpt-sovits-dl", "GPT-SoVITS-main"));
      cand.push(path.join(c, "gpt-sovits"));
    }
  }
  return cand.find(ok) || null;
}

/** 装了 GPT-SoVITS 依赖（torch/soundfile/faster-whisper...）的解释器 —— 它是独立 venv */
export function gsvPy(){
  const cand = [process.env.GSV_PY, path.join(ROOT, "runtime", "venv-gsv", "Scripts", "python.exe")];
  const home = gsvHome();
  if (home){
    // venv-gsv 和 gpt-sovits-dl 是兄弟目录
    const cloneDir = path.dirname(path.dirname(home));
    cand.push(path.join(cloneDir, "venv-gsv", "Scripts", "python.exe"));
    cand.push(path.join(path.dirname(home), "venv-gsv", "Scripts", "python.exe"));
  }
  return firstExe(cand);
}

/** 云端能不能用：edge 只要可执行文件在；付费 provider 还得有凭证 */
function cloudReady(){
  if (!edgeBin() && CLOUD_PROVIDER === "edge") return false;
  const need = {
    volc: process.env.VOLC_API_KEY ? [] :
          ((process.env.VOLC_APPID && process.env.VOLC_TOKEN) ? [] : ["VOLC_API_KEY"]),
    tencent: ["TENCENT_SECRET_ID", "TENCENT_SECRET_KEY", "TENCENT_APPID"],
    aliyun: ["ALIYUN_KEY_ID", "ALIYUN_KEY_SECRET"]
  }[CLOUD_PROVIDER] || [];
  return need.every(k => !!process.env[k]);
}

/** 三个引擎挑一个能用的：指定的 → gsv → f5 */
function engineNow(){
  if (ENGINE === "f5") return "f5";
  if (ENGINE === "cloud" && cloudReady()) return "cloud";
  if (gsvHome() && gsvPy()) return "gsv";
  return "f5";
}

/** 这台机器到底能不能自己出克隆音色 */
export function cloneReadiness(){
  const f5 = f5Home(), tts = pyTts(), qc = pyQc();
  const gsv = gsvHome(), gsvP = gsvPy(), edge = edgeBin();
  const eng = engineNow();
  const missing = [];
  if (!fs.existsSync(SKILL_SC)) missing.push("缺少配音脚本目录 connector/skills/voice-clone-dub/scripts");
  if (eng === "cloud"){
    if (CLOUD_PROVIDER === "edge" && !edge) missing.push("缺少 runtime/edge-tts（设 EDGE_TTS 指定）");
    if (!cloudReady()) missing.push(`${CLOUD_PROVIDER} 缺凭证（见 cloud-tts.mjs 顶部说明，或 ~/.workbuddy/voices/.cloud-key.json）`);
  } else if (eng === "gsv"){
    if (!gsv) missing.push("缺少 GPT-SoVITS 源码（设 GSV_HOME，约 1.1GB 权重另算）");
    if (!gsvP) missing.push("缺少 GPT-SoVITS 的 venv（需 torch 等依赖，设 GSV_PY 指定）");
  } else {
    if (!f5) missing.push("缺少 F5 权重（放到 weights/f5 或设 F5_HOME，约 1.4GB）");
    if (!tts) missing.push("缺少 Python 3.12（需装 torch 与 f5-tts，设 PY312 指定）");
  }
  if (!qc) missing.push("缺少 Python 3.13（需装 faster-whisper 与 pypinyin，设 PY313 指定）");
  return { ok: missing.length === 0, missing, f5, gsv, edge, engine: eng,
           provider: CLOUD_PROVIDER, voice: CLOUD_VOICE,
           py312: tts, py313: qc, pyTts: eng === "gsv" ? gsvP : tts };
}

/* ---------------- 音色档案 ---------------- */

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 三个查找根，同 key 先命中先用：
//   1 数据目录/voices       —— 这台机器自己的
//   2 ~/.workbuddy/voices  —— 命令行 dub.mjs 建档案的落点
//   3 <包根>/voices        —— 随包带的音色档案，同事解压就能用
const VOICE_ROOTS = [
  path.join(DIRS.root, "voices"),
  path.join(os.homedir(), ".workbuddy", "voices"),
  path.join(PKG_ROOT, "voices")
];

export function voiceRoot(){
  const own = VOICE_ROOTS[0];
  try { fs.mkdirSync(own, { recursive: true }); } catch(e){}
  return own;
}

function readProfile(dir){
  try {
    const metaFile = path.join(dir, "meta.json");
    if (!fs.existsSync(metaFile) || !fs.existsSync(path.join(dir, "ref.wav"))) return null;
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    const refTxtFile = path.join(dir, "ref.txt");
    const bgmFile = path.join(dir, "bgm.mp3");
    return {
      key: path.basename(dir),
      dir,
      name: meta.name || path.basename(dir),
      source: meta.source || "",
      ref: path.join(dir, "ref.wav"),
      refText: fs.existsSync(refTxtFile) ? fs.readFileSync(refTxtFile, "utf8").trim() : "",
      bgm: fs.existsSync(bgmFile) ? bgmFile : null,
      refTextVerified: meta.refTextVerified === true,
      dur: Number(meta.dur) || 0
    };
  } catch(e){ return null; }
}

/** 两个根目录里的档案合并，同 key 以服务数据目录优先 */
export function listCloneVoices(){
  const seen = new Map();
  for (const root of VOICE_ROOTS){
    let subs = [];
    try { subs = fs.readdirSync(root); } catch(e){ continue; }
    for (const k of subs){
      if (seen.has(k)) continue;
      const p = readProfile(path.join(root, k));
      if (p) seen.set(k, p);
    }
  }
  return [...seen.values()].map(p => ({
    key: p.key, name: p.name, source: p.source,
    hasBgm: !!p.bgm, refTextVerified: p.refTextVerified, dur: p.dur
  }));
}

export function findCloneVoice(key){
  const k = String(key || "").trim();
  if (!/^[0-9a-zA-Z_-]{4,40}$/.test(k)) return null;
  for (const root of VOICE_ROOTS){
    const p = readProfile(path.join(root, k));
    if (p) return p;
  }
  return null;
}

/* ---------------- 子进程 ---------------- */

function runAsync(bin, args, opt = {}){
  return new Promise(resolve => {
    let out = "", err = "";
    let lineBuf = "";
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, env: { ...process.env, ...(opt.env || {}) } });
    } catch(e){ return resolve({ code: -1, out: "", err: String(e.message) }); }
    child.stdout?.on("data", d => {
      out += d;
      if (out.length > 200000) out = out.slice(-100000);
      // 流式回调：合成是几分钟级的长任务，不能等进程退出才把进度吐出来，
      // 否则用户看到的就是「一直不动」，以为卡死。
      if (typeof opt.onLine === "function"){
        lineBuf += d.toString();
        let nl;
        while ((nl = lineBuf.indexOf("\n")) >= 0){
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (line) { try { opt.onLine(line); } catch(e){} }
        }
      }
    });
    child.stderr?.on("data", d => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    child.on("error", e => resolve({ code: -1, out, err: String(e.message) }));
    child.on("close", code => {
      if (typeof opt.onLine === "function" && lineBuf.trim()){
        try { opt.onLine(lineBuf.trim()); } catch(e){}
      }
      resolve({ code, out, err });
    });
  });
}

async function must(bin, args, label, env, onLine){
  const r = await runAsync(bin, args, { env, onLine });
  if (r.code !== 0){
    const msg = ((r.stderr || "") + (r.stdout || "")).trim().split("\n").filter(Boolean).slice(-4).join(" | ");
    throw Object.assign(new Error(`${label}失败：${msg || "退出码 " + r.code}`), { code: 500 });
  }
  return r;
}

function splitScript(text, max = SEG_MAX){
  const parts = String(text).split(/(?<=[，。！？；：、,.!?;:])/).filter(s => s.trim());
  const out = [];
  let cur = "";
  for (const p of parts){
    if ((cur + p).length > max && cur){ out.push(cur); cur = ""; }
    cur += p;
  }
  if (cur) out.push(cur);
  const fixed = [];
  for (const s of out){
    if (s.length <= max * 1.6){ fixed.push(s); continue; }
    for (let i = 0; i < s.length; i += max) fixed.push(s.slice(i, i + max));
  }
  return fixed.filter(s => s.trim());
}

/** 拼音覆盖率质检：念全的段实测 1.000，丢字的段 0.86 左右（这里只做单段调试用） */

/* ---------------- 主流程 ---------------- */

/**
 * 从参考视频里分离出纯伴奏（人声剔除），拿它当成片的 BGM。
 *
 * 为什么必须分离：以前是「把参考视频整条原声压低 9dB 当背景床」，可那条轨里
 * 有参考视频的人在说话，和我们自己的配音叠在一起就是两层人声糊住。
 * 走技能里那套 HDEMUCS（py3.12 + torch），48s 素材约 10s 跑完。
 *
 * @param {string} media   参考视频/音频路径
 * @param {string} workDir 本次任务的临时目录
 * @returns {Promise<string>} 伴奏 wav 路径
 */
export async function separateBgm(media, workDir, onLog = () => {}){
  const py = pyTts();
  if (!py) throw Object.assign(new Error("本机没有装 torch 的 Python 3.12，跑不了人声分离"), { code: 409 });
  const dir = path.join(workDir, "sep");
  fs.mkdirSync(dir, { recursive: true });
  onLog("正在从参考视频里分离人声与伴奏（HDEMUCS）…");
  const r = await runAsync(py, [path.join(SKILL_SC, "sep-any.py"), media, dir], {
    env: { FFMPEG: BIN.ffmpeg, FFMPEG_PATH: BIN.ffmpeg }
  });
  const bgm = path.join(dir, "bgm.wav");
  // 把子进程输出留一份：分离失败时靠它定位（以前只在日志里截三行，什么都看不出来）
  try {
    fs.writeFileSync(path.join(dir, "sep.log"),
      `exit=${r.code}\n--- stdout ---\n${r.out || ""}\n--- stderr ---\n${r.err || ""}\n`, "utf8");
  } catch(e){}
  const okBgm = fs.existsSync(bgm) && fs.statSync(bgm).size > 100 * 1024;
  if (r.code !== 0 && !okBgm){
    const msg = ((r.err || "") + (r.out || "")).trim().split("\n").filter(Boolean).slice(-3).join(" | ");
    throw Object.assign(new Error(msg || `人声分离失败（退出码 ${r.code}）`), { code: 500 });
  }
  // 产物在、码不对：Windows 上 torch 收尾偶尔会带个非零退出码，伴奏本身是好的，照用
  if (r.code !== 0) onLog(`人声分离进程退出码 ${r.code}，但伴奏已生成，继续使用`);
  // 分轨中间产物一个 8MB，留着没用
  for (const n of fs.readdirSync(dir)){
    if (/^(stem_|_in44|ref_seg)/.test(n)){ try { fs.unlinkSync(path.join(dir, n)); } catch(e){} }
  }
  return bgm;
}

/**
 * 用克隆音色把文案变成配音。
 *
 * 节奏为什么以前总是错的（三个原因，缺一不可地叠在一起）：
 *   1 分段按标点凑够 60 字才切 —— 一段里塞 5 行，行与行连读，中间没有换气口；
 *   2 F5 原生语速实测 6.5–7.5 字/秒，比正常口播（4.2）快了近一倍；
 *   3 用户的 speed 直接当 atempo 用，设 1× 就等于完全不管，设 1.1× 反而更快。
 * 现在改成：一行一段 → 逐段裁头尾静音 → 量出实际语速折算 atempo → 段间插固定停顿。
 *
 * @param {object}   opt
 * @param {string}   opt.voiceKey  音色档案 key（listCloneVoices 里的 key）
 * @param {string}   opt.script    文案原文
 * @param {string[]} opt.lines     文案按行切好的数组（有就逐行合成）
 * @param {boolean}  opt.perLine   是否逐行（默认 true）
 * @param {number}   opt.speed     目标语速倍率（1 = 4.2 字/秒）
 * @param {string}   opt.workDir   工作目录
 * @param {function} opt.onLog     进度回调，写进任务日志
 * @returns {{vo: string, bgm: string|null, durMs: number, items: object[], gapMs: number, note: string[]}}
 */
export async function synthesizeClone(opt = {}){
  const log = typeof opt.onLog === "function" ? opt.onLog : () => {};
  const ready = cloneReadiness();
  if (!ready.ok) throw Object.assign(new Error("本机克隆不可用：" + ready.missing.join("；")), { code: 409 });

  // 云端音色不依赖音色档案（edge 的 preset 根本不需要 ref），档案缺失也照跑；
  // 用占位档案兜住后面所有 profile.xxx 的引用，BGM 走任务自带的那条。
  const isCloud = ready.engine === "cloud";
  let profile = findCloneVoice(opt.voiceKey);
  if (!profile && isCloud){
    profile = { key: "cloud", dir: null, name: "云端音色 " + (CLOUD_SPEAKER || CLOUD_VOICE),
                source: "", ref: null, refText: "", bgm: null, refTextVerified: true, dur: 0 };
  }
  if (!profile) throw Object.assign(new Error("找不到这个克隆音色，可能已被删除"), { code: 404 });
  if (!profile.refText && !isCloud) throw Object.assign(new Error("音色档案里没有参考文本（ref.txt），克隆没法对齐韵律"), { code: 409 });
  if (!profile.refTextVerified && !isCloud) log("音色参考文本是转写草稿，同音字可能影响效果");

  const work = opt.workDir;
  fs.mkdirSync(work, { recursive: true });

  /* ---------------- 分段：一行就是一句 ---------------- */
  const asked = Array.isArray(opt.lines)
    ? opt.lines.map(s => String(s || "").replace(/\u200b/g, "").trim()).filter(Boolean)
    : [];
  const perLine = opt.perLine !== false && asked.length > 0;
  const segs = perLine ? asked : splitScript(opt.script);

  /* ---------------- 目标语速与停顿 ---------------- */
  const userSpeed = Math.min(2, Math.max(0.5, Number(opt.speed) || 1));
  // 5.0 字/秒是短视频口播的舒适区（标准播音 4.2 偏慢，成片会显得拖）。
  const TARGET_CPS = Number(process.env.CLONE_CPS || 5.0);
  const targetCps = TARGET_CPS * userSpeed;
  // F5 原生语速实测 9–10 字/秒（参考音频才 5.4）。要压到 5 字/秒只有两条路：
  //   ① 模型 speed<1 —— 拉长目标时长，模型自己念慢，音色和清晰度都在；
  //   ② ffmpeg atempo 硬拉 —— 实测 0.55× 后连 whisper 都把「人先」听成「神仙」，
  //      人耳更糊。所以主用 ①，② 只留 ±20% 做微调。
  // 模型语速的起点：
  //   F5 ：原生语速实测 9–10 字/秒（参考音频才 5.4），要压到 5 字/秒得 speed≈0.62，
  //        剩下的交给 atempo 微调。硬拉（<0.8×）实测连 whisper 都把「人先」听成「神仙」。
  //   GSV：原生就贴着参考音频的语速（实测 5.5–6 字/秒），speed 保持 1.0 最自然，
  //        差的那一点全交给下面的逐句 atempo，幅度小到听不出拉伸。
  //   cloud：edge 的 rate 实测是线性的（1.0→3.8 字/秒、1.4→5.3、1.6→6.0），
  //        中文默认语速偏慢，1.3 起步刚好落在 5 字/秒附近，剩下的交给逐句 atempo。
  //        它允许 >1（rate 是百分比加速），所以上限单独放宽到 2。
  const SPEED_CAP = ready.engine === "cloud" ? 2 : 1;
  const DEFAULT_SPEED = ready.engine === "cloud"
    ? (CLOUD_PROVIDER === "volc" ? 1.0 : 1.3)   // 火山 2.0 原生就 5 字/秒，不用加速
    : (ready.engine === "gsv" ? 1.0 : 0.62);
  const MODEL_SPEED = Math.min(SPEED_CAP, Math.max(0.4,
    Number(process.env.CLONE_MODEL_SPEED || DEFAULT_SPEED)));
  const TEMPO_MIN = 0.8, TEMPO_MAX = 1.2;
  // 裁漏字（见下面 leakCuts）必须在「这段字还念得完」的前提下进行：
  // 实测 6 字的「人先破产吗？」被裁到 0.76 秒 = 7.9 字/秒，听起来就是吞字。
  // 按「最快 6.4 字/秒」倒推每句能裁的上限，超过就宁可留一点残留也不再往里切。
  const MAX_CPS = Number(process.env.CLONE_MAX_CPS || 6.4);
  // 漏字长度是随机的（同一句实测出现过「上」「以上」「以上有」三种）。
  // 现在漏字再长也不会让句子变赶（裁完靠逐句拉伸把语速拉回来），所以默认不重录，
  // 一次重录 60s 不值得；真遇到怪样本可以设 CLONE_LEAK_RETRY=1/2。
  const LEAK_RETRY = Number(process.env.CLONE_LEAK_RETRY || 0);
  // 句间停顿：段首那段换气静音留着的，所以这里补 450ms ——
  // 实测有的段开头几乎没静音，补 300ms 时最短只剩 0.14s，听感上两句黏在一起。
  // 补 450ms 后最短也在 0.45s 以上，最长约 0.8s，换气刚好。
  const gapMs = Math.max(0, Math.round(Number(process.env.CLONE_GAP_MS ?? 450)));

  log(`克隆配音：${String(opt.script).length} 字 / ${segs.length} 段${perLine ? "（一行一段，逐句断开）" : ""} · ${ready.engine === "cloud" ? `云端音色 ${CLOUD_SPEAKER || CLOUD_VOICE}（${CLOUD_PROVIDER}）` : `音色「${profile.name}」`} · 引擎 ${ready.engine === "cloud" ? "云端 TTS" : ready.engine === "gsv" ? "GPT-SoVITS" : "F5"} · 目标 ${targetCps.toFixed(1)} 字/秒 · 模型语速 ${MODEL_SPEED}×`);

  const pyTtsBin = ready.pyTts, pyQcBin = ready.py313;
  const env = { ...process.env, F5_HOME: ready.f5, GSV_HOME: ready.gsv };
  // F5 才需要「漏字」这一整套修补；GSV 从根上没有这条尾巴，下面的检漏/复查/重录全部跳过。
  const LEGACY = ready.engine === "f5";
  const TTS_SCRIPT = path.join(SKILL_SC,
    ready.engine === "gsv" ? "gsv-tts.py"
    : ready.engine === "cloud" ? "cloud-tts.mjs" : "clone-tts.py");
  // cloud-tts.mjs 是 node 脚本，不是 python；执行器要跟着换
  const TTS_BIN = ready.engine === "cloud" ? process.execPath : pyTtsBin;
  const QC_SCRIPT = path.join(SKILL_SC, "qc-seg.py");
  const LEAK_SCRIPT = path.join(SKILL_SC, "leak-trim.py");
  const REFWIN_SCRIPT = path.join(SKILL_SC, "ref-window.py");

  /* ---------------- 参考音频 ---------------- */
  // F5 是拿参考音频当「上文」往下续写的：它把 ref 和要生成的句子拼成一条一起采样，
  // 再按 ref_audio_len 切掉前半段。实测结果是参考音频的尾字会漏进每一段开头——
  // 这个音色的参考音频最后一句是「…都在85%以上」，于是每段开头都先冒一个「上」
  // （0.2–0.5s，短句上尤其明显，听感就是每次断句都先「上」一声）。
  // 试过给 ref 补留白、做淡出、patch F5 的 remove_silence_edges，都拦不住
  // （它本质是模型接着上文写，不是切分点算错）。
  // 所以改成生成后精确裁掉：用词级时间戳找到正文真正开始的位置（见 detectLeak）。
  const refFile = profile.ref, refTxt = profile.refText;

  /* ---------------- GSV：参考音频先裁成 3~10 秒 ----------------
     GPT-SoVITS 对 prompt 音频有硬限制（TTS.py 里直接 raise「参考音频在3~10秒范围外」），
     而音色档案是从视频里整段切出来的，实测这条 12.3 秒，一进去就报错。
     不能简单 `ffmpeg -t 8`：参考文本必须和音频逐字对应，文本没跟着截，韵律就对不上。
     所以交给 ref-window.py 做词级对齐后按字边界切，结果按 mtime 缓存在音色目录里。 */
  let gsvRef = refFile, gsvRefText = refTxt;
  if (ready.engine === "gsv"){
    const cw = path.join(profile.dir, "ref_gsv.wav");
    const ct = path.join(profile.dir, "ref_gsv.txt");
    const upToDate = () => {
      try {
        const m = fs.statSync(refFile).mtimeMs;
        return fs.existsSync(cw) && fs.existsSync(ct)
          && fs.statSync(cw).mtimeMs >= m && fs.statSync(ct).mtimeMs >= m;
      } catch(e){ return false; }
    };
    if (upToDate()){
      gsvRef = cw;
      gsvRefText = fs.readFileSync(ct, "utf8").trim();
    } else {
      const tmpTxt = path.join(work, "_ref_text.txt");
      fs.writeFileSync(tmpTxt, refTxt, "utf8");
      // 音色目录可能不可写（随包带的档案），所以失败就落到 work 目录，只是不缓存
      for (const dir of [profile.dir, work]){
        const r = await runAsync(pyQcBin, [REFWIN_SCRIPT, "--ref", refFile, "--text", tmpTxt,
          "--out-dir", dir, "--prefix", "ref_gsv"]);
        const line = String(r.out || "").split(/\r?\n/).find(x => /^(OK|SKIP)\b/.test(x.trim()));
        if (!line){ continue; }
        if (line.startsWith("SKIP")){ gsvRef = refFile; gsvRefText = refTxt; break; }
        const f = path.join(dir, "ref_gsv.wav"), t = path.join(dir, "ref_gsv.txt");
        if (fs.existsSync(f) && fs.existsSync(t)){
          gsvRef = f;
          gsvRefText = fs.readFileSync(t, "utf8").trim();
          const mm = /^OK\s+([\d.]+)\s+(\d+)/.exec(line.trim());
          if (mm) log(`参考音频裁到 ${(+mm[1]).toFixed(2)}s / ${mm[2]} 字 给 GPT-SoVITS（原 ${(profile.dur || 0).toFixed(1)}s）`);
          break;
        }
      }
      if (gsvRef === refFile) log("参考音频没裁成功，按原文件送进去（超 10 秒可能会被 GPT-SoVITS 拒）");
    }
  }

  /* ---------------- 批量合成：一次加载、循环合成 ---------------- */
  // 为什么不再并行：F5 每段都要把参考音频（12s≈1150 帧）整体参与采样，
  // 生成 11 个字只占其中 190 帧，86% 的算力烧在参考段上——单进程已经吃 2–3 核。
  // 实测开 4 路并行反而更慢（每进程只分到 1.9 核，首段从 3 分钟拖到 6 分钟）。
  // 所以老老实实单进程串行，靠「模型只加载一次」省时间。
  const PARALLEL = 1;
  const synthRound = async (idxList, tag, speedOf = null) => {
    const out = new Map();          // 全局段号 → { file, dur }
    if (!idxList.length) return out;
    let done = 0;
    const lanes = Math.min(PARALLEL, idxList.length);
    const per = Math.ceil(idxList.length / lanes);
    const groups = [];
    for (let i = 0; i < idxList.length; i += per) groups.push(idxList.slice(i, i + per));

    await Promise.all(groups.map(async (grp, gi) => {
      const sub = `${tag}_${gi}`;
      const listFile = path.join(work, `round${sub}.txt`);
      // 句尾补标点再喂模型：F5 对「设备没回本」这种没标点的短句容易吞最后一个字
      // （转写里就是少了「本」）。补个句号，它才知道这句到头了。
      // 只影响合成，字幕和质检仍用原文。
      const forTts = i => (/[。！？!?…，,；;：:]$/.test(segs[i]) ? segs[i] : segs[i] + "。");
      fs.writeFileSync(listFile, grp.map(forTts).join("\n"), "utf8");
      const outDir = path.join(work, `r${sub}`);
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch(e){}
      fs.mkdirSync(outDir, { recursive: true });
      const args = isCloud
        ? [
            TTS_SCRIPT,
            "--provider", CLOUD_PROVIDER, "--voice", CLOUD_VOICE,
            "--gen-list", listFile, "--out-dir", outDir,
            "--speed", String(MODEL_SPEED)
          ]
        : [
            TTS_SCRIPT,
            "--ref", gsvRef, "--ref-text", gsvRefText,
            "--gen-list", listFile, "--out-dir", outDir,
            "--nfe", String(opt.nfe || CLONE_NFE), "--speed", String(MODEL_SPEED)
          ];
      // 复刻类 provider 要把训练出来的音色 ID 和参考音频一起带上
      if (isCloud && CLOUD_SPEAKER) args.push("--speaker", CLOUD_SPEAKER);
      if (isCloud && gsvRef) args.push("--ref", gsvRef, "--ref-text", gsvRefText || "");
      if (speedOf){
        // 逐段语速：短的句子要让模型念慢一点，段落才有富余时长留给「裁掉开头漏字」
        const spFile = path.join(work, `round${sub}_speed.txt`);
        fs.writeFileSync(spFile, grp.map(i => (speedOf.get(i) ?? MODEL_SPEED).toFixed(3)).join("\n"), "utf8");
        args.push("--speed-list", spFile);
      }
      const r = await must(TTS_BIN, args, `批量合成（${grp.length} 段）`, env, line => {
        // 每合成完一段就报一次，用户才知道还在动（以前 4 段之间隔 5 分钟，看着像卡死）
        const m = /^SEG\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d.]+)/.exec(line);
        if (m){
          done++;
          log(`配音 ${done}/${idxList.length} 段完成 · 第 ${grp[+m[1]] + 1} 句 ${m[3]} 字 → ${(+m[2]).toFixed(2)}s（本段算 ${(+m[4]).toFixed(0)}s）`);
        } else if (/模型就绪|加载模型|归一化/.test(line)){
          log("  " + line.replace(/\s+/g, " ").trim());
        }
      });
      const hits = [];
      for (const ln of String(r.out || "").split(/\r?\n/)){
        const m = /^SEG\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d.]+)(?:\s+([\d.]+))?/.exec(ln.trim());
        if (m){
          hits[+m[1]] = {
            file: path.join(outDir, `seg_${String(+m[1]).padStart(2, "0")}.wav`),
            dur: +m[2], chars: +m[3], speech: m[5] != null ? +m[5] : +m[2]
          };
        }
      }
      // SEG 行没打出来（脚本中途退出）就按文件补齐，不让整单崩掉
      for (let k = 0; k < grp.length; k++){
        const f = path.join(outDir, `seg_${String(k).padStart(2, "0")}.wav`);
        if (!hits[k] && fs.existsSync(f)){
          const d = (await probe(f))?.duration || 0;
          hits[k] = { file: f, dur: d, chars: segs[grp[k]].length, speech: d };
        }
        if (hits[k]) out.set(grp[k], hits[k]);
        else log(`第 ${grp[k] + 1} 段没有产出音频`);
      }
    }));
    return out;
  };

  /* ---------------- 逐段整形：只裁尾静音 → 变速 → 修边 ---------------- */
  // 为什么不裁段首：F5 每段开头自带 0.2–0.35s 静音，那是换气，留着语气才自然。
  // 之前连段首一起裁（-40dB），5 个字的短句直接从小半截被削没（实测 0.715s→0.467s），
  // 字都丢了还怎么谈节奏。现在只削尾巴，阈值放到 -50dB、至少 0.12s，只削真空，不碰尾音。
  // 注意 start_duration 的语义：它是「削掉开头静音之后，再多削这么长」——
  // 不是「静音要持续这么久才算静音」。以前写 start_duration=0.12，等于每句尾部
  // 往语音里多切 0.12 秒：实测原始段尾部静音 0.678s，整形后削掉 0.798s，
  // 正好多 0.12s，把「人先破产吗」的「吗」、「没选出来」的「来」全切没了，
  // 转写出来就是「人先破产」「没选出」。改成 start_silence 保留 30ms 静音，
  // 只削真空、绝不侵入语音。
  const TRIM_TAIL = "areverse,silenceremove=start_periods=1:start_silence=0.03:start_threshold=-45dB:detection=peak,areverse";
  const FADE = "afade=t=in:st=0:d=0.008,areverse,afade=t=in:st=0:d=0.008,areverse";
  let tempo = 1;

  /* 漏字兜底：参考尾音漏进来时会形成「开头静音 → 一个很短的语音 → 静音」的形态，
     实测那个「上」只有 0.23s。正常正文第一句不可能这么短（最短也在一秒上下），
     所以只要出现「<0.45s 的孤立开头语音」，就认定是漏字，从后面那句正话开始。 */
  const silences = (src, noise = "-38dB", d = 0.05) => {
    try {
      const r = spawnSync(BIN.ffmpeg, ["-hide_banner", "-i", src, "-af",
        `silencedetect=noise=${noise}:d=${d}`, "-f", "null", "-"], { encoding: "utf8" });
      const out = [];
      let cur = null;
      for (const ln of String(r.stderr || "").split("\n")){
        const a = /silence_start:\s*([\d.]+)/.exec(ln);
        const b = /silence_end:\s*([\d.]+)/.exec(ln);
        if (a) cur = { s: +a[1] };
        if (b && cur){ cur.e = +b[1]; out.push(cur); cur = null; }
      }
      return out;
    } catch(e){ return []; }
  };

  // 段首留白长度（F5 每段开头都垫 0.2–0.35s 静音）。
  // 不裁它的话，段与段之间的「停顿」会被拆成「段尾静音 + 450ms 间隔 + 段首静音」两截，
  // 中间被拼接处的轻微台阶分开，实测被数成 5 处停顿、最短 0.24s——
  // 听感上没问题，但节奏检查会判不合格，而且整条配音也白白长了一两秒。
  const headSilence = (src) => {
    const s = silences(src);
    return (s.length && s[0].s < 0.03 && s[0].e > 0.02) ? s[0].e : 0;
  };

  const leakHeadCut = (src) => {
    const sils = silences(src);
    if (sils.length >= 2 && sils[0].s < 0.03 && sils[1].e < 1.0){
      const len = sils[1].s - sils[0].e;
      if (len > 0.05 && len < 0.45) return sils[1].e;
    }
    return 0;
  };

  const shapeOne = async (src, outFile, startSec = 0, t = 1) => {
    const chain = [];
    if (startSec > 0.02) chain.push(`atrim=start=${startSec.toFixed(3)}`, "asetpts=PTS-STARTPTS");
    chain.push(TRIM_TAIL);
    if (Math.abs(t - 1) > 0.01) chain.push(`atempo=${t.toFixed(4)}`);
    chain.push(FADE);
    await must(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", src,
      "-filter:a", chain.join(","), "-ar", "44100", "-ac", "1", outFile], `第 ${path.basename(outFile)} 整形`);

    // 收尾两件事，一起做：
    // ① 开头就是静音（F5 每段都垫 0.2–0.35s）：只留 60ms 换气，不然段间停顿会被拆成两截。
    // ② 「开头一小截残音 + 一段停顿」：裁漏字是按时间戳切的，切点偏早会剩几十毫秒尾音
    //    （听感就是每句开头「啧」一下）。只要开头有一小截声音、紧接着 0.15s 以上静音，
    //    那截声音必然是漏字的尾巴，直接从静音结束处起。
    // 阈值用 -38dB：残音往往很轻，-45dB 判不出来（实测那截 0.2s 的静音在 -45dB 下"有声音"）。
    // GSV 不用这一段：它开头没有漏字，偶尔出现的短音节是真正的字头，裁掉就吞字了。
    const sils = LEGACY ? silences(outFile, "-38dB", 0.12) : [];
    let cutAt = 0;
    if (LEGACY && sils.length && sils[0].s < 0.008){
      if (sils[0].e > 0.15) cutAt = sils[0].e - 0.06;
    } else {
      const gap = sils.find(x => x.s < 0.25 && (x.e - x.s) >= 0.15);
      if (gap && gap.s > 0.008) cutAt = gap.e - 0.06;
    }
    if (cutAt > 0.02){
      const fix = outFile + ".fix.wav";
      await must(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", outFile,
        "-filter:a", `atrim=start=${cutAt.toFixed(3)},asetpts=PTS-STARTPTS,${TRIM_TAIL},${FADE}`,
        "-ar", "44100", "-ac", "1", fix], `第 ${path.basename(outFile)} 清残音`);
      fs.renameSync(fix, outFile);
    }
    return Math.round(((await probe(outFile))?.duration || 0) * 1000);
  };

  /* 泄字检测：拿词级时间戳找「正文真正从第几秒开始」。
     这是唯一可靠的办法——能量/静音检测抓不到（泄漏字和正文常常连读），
     改参考音频也拦不住（模型是接着上文续写，不是切分点算错）。
     注意它本身也会漏判（实测 4 句漏 1 句），所以裁完必须复查，见下面的复查循环。 */
  const leakCuts = new Map();
  const detectLeakOn = async (pairs) => {
    const out = new Map();
    // GSV 没有漏字，整条检漏链路直接返回空 —— 上面所有依赖它的分支（重录/复查/裁切）自然空转
    if (!LEGACY) return out;
    const list = [], args = [];
    for (const { i, file } of pairs){
      if (!file || !fs.existsSync(file)) continue;
      const txt = path.join(work, `leak_${String(i).padStart(2, "0")}_${args.length}.txt`);
      fs.writeFileSync(txt, segs[i], "utf8");
      list.push(i);
      args.push(file, txt);
    }
    if (!args.length) return out;
    const r = await runAsync(pyQcBin, [LEAK_SCRIPT, ...args]);
    let hits = 0;
    for (const ln of String(r.out || "").split(/\r?\n/)){
      const s = ln.trim();
      if (!s.startsWith("{")) continue;
      let d;
      try { d = JSON.parse(s); } catch(e){ continue; }
      const i = list[d.idx];
      if (i == null) continue;
      hits++;
      const cut = Math.max(0, Number(d.cut) || 0);
      if (cut > 0.04) out.set(i, { cut, leak: d.leak || "" });
    }
    if (!hits){
      const msg = ((r.err || "") + (r.out || "")).trim().split("\n").filter(Boolean).slice(-2).join(" | ");
      log(`泄字检测没出结果（${msg || "退出码 " + r.code}），按原样继续`);
    }
    return out;
  };
  const detectLeak = (idxList) =>
    detectLeakOn(idxList.map(i => ({ i, file: got.get(i)?.file })));

  /* ---------------- 批量质检 ---------------- */
  const qcBatch = async (pairs) => {
    if (!pairs.length) return [];
    const args = [];
    for (const p of pairs) args.push(p.wav, p.txt);
    const r = await runAsync(pyQcBin, [QC_SCRIPT, ...args]);
    const out = [];
    for (const ln of String(r.out || "").split(/\r?\n/)){
      const s = ln.trim();
      if (!s.startsWith("{")) continue;
      try { out.push(JSON.parse(s)); } catch(e){}
    }
    if (!out.length){
      const msg = ((r.err || "") + (r.out || "")).trim().split("\n").filter(Boolean).slice(-3).join(" | ");
      log(`质检没出结果（${msg || "退出码 " + r.code}），本轮按通过处理`);
    }
    return out;
  };

  /* ---------------- 合成 → 量语速 → 整形 ---------------- */
  const allIdx = segs.map((_, i) => i);
  const charsOf = i => segs[i].replace(/\s/g, "").length;
  const got = new Map();       // 段号 → { file, dur, chars, speech }
  const shaped = new Map();    // 段号 → { wav, durMs }
  const extraTempo = new Map();// 段号 → 这一句自己的变速系数（逐句拉齐语速用）
  const rateOf = g => (g && g.speech > 0.05) ? (g.chars / g.speech) : 0;

  /* 裁切量封顶：留够「这段字念完」的时长，再多一点余量都不给。
     need 是整形后口径（已经过 atempo），乘 tempo 换回整形前口径——
     tempo<1 是放慢，整形后的时长会被 /tempo 拉长，所以可用空间是 dur - need*tempo。
     段首静音反正也要去掉，不计入可用时长。 */
  const headTrim = new Map();   // 源文件 → 段首静音长度（重录会换文件，所以按文件缓存）
  const hsOf = (file) => {
    if (!file) return 0;
    if (!headTrim.has(file)) headTrim.set(file, headSilence(file));
    return headTrim.get(file) || 0;
  };
  const tempoOf = i => (tempo || 1) * (extraTempo.get(i) || 1);
  const capCut = (i, want, dur) => {
    const need = charsOf(i) / MAX_CPS;
    // 裁完剩下的是 dur - cut，必须还够把这段字念完。
    // 注意别再把段首静音另外减掉：cut 通常已经把那段静音吃进去了（cut 常常大于静音长度），
    // 两边都减就成了重复扣，短句会被误判「念不完了」，漏字永远清不掉。
    const room = Math.max(0, dur - need * tempoOf(i));
    return Math.max(0, Math.min(want, room));
  };

  const shapeAll = async (idxList) => {
    for (const i of idxList){
      const g = got.get(i);
      if (!g) continue;
      const out = path.join(work, `seg_${String(i).padStart(2, "0")}_s.wav`);
      let cut = leakCuts.get(i) || 0;
      if (!cut && LEGACY){
        const guess = leakHeadCut(g.file);
        // 兜底手段同样封顶，不然短句一样会被切到念不完
        if (guess > 0){
          cut = Math.min(guess, capCut(i, guess, g.dur || 0));
          if (cut > 0.04) log(`第 ${i + 1} 句开头有 ${Math.round(cut * 1000)}ms 孤立音节，已裁掉`);
        }
      }
      // 顺手把段首那 0.2–0.35s 静音也去掉，只留 80ms 换气。
      // 漏字裁切点常常落在静音里，光靠 cut 去不掉那截静音。
      const hs = hsOf(g.file);
      const startAt = Math.max(cut, hs > 0.1 ? hs - 0.08 : 0);
      shaped.set(i, { wav: out, durMs: await shapeOne(g.file, out, startAt, tempoOf(i)) });
    }
  };

  /* 裁完复查：检测器本身会漏判（实测 4 句漏 1 句），裁完再看一遍，
     还有残留就继续往里裁，最多两轮。
     门槛 120ms：复查是在「已经裁过、只剩 1 秒上下」的短音频上跑的，
     这种长度上 whisper 幻觉很重。一个字的残留少说 200ms，不到 120ms 的都是噪声。
     换算注意：这里的 cut 是在「已经 atempo 过」的音频上量的，
     换回原始口径要 ×tempo（tempo<1 是放慢，1ms 残留在原始音频里其实更长）。
     之前写成 /tempo，过裁了 23%，6 字句就是这么被切成 0.76 秒的。 */
  const RECHECK_MIN = Number(process.env.CLONE_RECHECK_MIN || 0.12);
  const recheckLoop = async (idxList) => {
    if (!LEGACY) return;
    for (let k = 0; k < 2; k++){
      const again = await detectLeakOn(idxList.map(i => ({ i, file: shaped.get(i)?.wav })));
      if (!again.size) break;
      let any = false;
      for (const [i, d] of again){
        const dur = got.get(i)?.dur || 0;
        const prev = leakCuts.get(i) || 0;
        if (d.cut < RECHECK_MIN) continue;
        const want = prev + d.cut * tempoOf(i) + 0.02;
        const next = Math.min(capCut(i, want, dur), dur * 0.4);
        if (next > prev + 0.05){
          leakCuts.set(i, next);
          log(`第 ${i + 1} 句复查仍有「${d.leak}」残留 → 再裁 ${Math.round((next - prev) * 1000)}ms`);
          any = true;
        } else if (want > next + 0.05){
          log(`第 ${i + 1} 句还有「${d.leak}」残留，但再裁这句就念不完了（下限 ${(charsOf(i) / MAX_CPS).toFixed(2)}s），保留`);
        }
      }
      if (!any) break;
      await shapeAll(idxList);
    }
  };

  const runPass = async (idxList, tag) => {
    const fresh = await synthRound(idxList, tag);
    for (const [i, g] of fresh) got.set(i, g);

    // 第一遍：分析原始段，定出每句要裁多少
    const first = await detectLeak(idxList);

    /* 短句 + 长漏字 = 这一段音频本身就不够长。
       漏字占掉 0.45s，6 字的正文只剩 0.6–0.9s，裁完想回到 5 字/秒得拉到 0.55×，
       那就是糊的（实测 0.55× 之后「人先」被听成「神仙」）。
       与其硬拉，不如让模型把这段念慢一点重录一版：把模型语速按需要的倍数降下去，
       段落自己变长，裁完刚好落在目标语速。只重录这种句子。

       GSV 更依赖这条路：它原生语速贴着参考音频（实测短句能到 8.5 字/秒），
       而 atempo 下限只能到 0.75×，单靠拉伸最多压到 6.4 字/秒 —— 听感明显赶。
       用 speed_factor 让模型自己念慢，音色和咬字都不动。
       注意必须按「真实语音时长」估：GSV 每段尾部自带约 0.3s 静音，
       拿整段时长算会把 7.1 字/秒摊成 5.3，低于阈值就永远不触发重录。 */
    const slower = new Map();
    const slowNote = [];
    const stretchOf = (i, g, cut) => {
      const textSec = (g.speech > 0.05 && !LEGACY)
        ? g.speech
        : (g.dur - Math.max(cut, hsOf(g.file) - 0.08));
      return textSec < 0.2 ? 0 : (charsOf(i) / textSec) / targetCps;
    };
    // GSV 的压缩余量更小，阈值放低一点：超过 1.15× 就重录，省得全靠 atempo 硬拉
    const SLOW_TRIGGER = Number(process.env.CLONE_SLOW_TRIGGER || (LEGACY ? 1.28 : 1.15));
    const stretch0 = new Map();
    for (const i of idxList){
      const g = got.get(i);
      if (!g) continue;
      const stretch = stretchOf(i, g, first.get(i)?.cut || 0);   // >1：需要拉慢的倍数
      if (stretch > 0) stretch0.set(i, stretch);
      if (stretch > SLOW_TRIGGER){
        // 下调有界（最多 1.5×）：实测 GPT-SoVITS 的 speed_factor 接近线性
        // （6 字短句 speed 1.0→1.06s、0.6→1.51s），但越往下压收益越平，
        // 而且一压过头就得靠 atempo 提回来，反而卡在上限。
        // 留 1.5× 给模型、剩下的交给逐句 atempo，两头都不出界。
        slower.set(i, Math.max(0.55, MODEL_SPEED / Math.min(stretch, 1.5)));
        slowNote.push(`第${i + 1}句 ${stretch.toFixed(2)}×`);
      }
    }
    if (slower.size){
      const list = [...slower.keys()];
      log(`${slowNote.join("、")} 语速超出 ${SLOW_TRIGGER}× 的拉伸余量，改用更慢的模型语速重录这几句`);
      const re = await synthRound(list, `${tag}z`, slower);
      const ms = await detectLeakOn(list.map(i => ({ i, file: re.get(i)?.file })));
      for (const i of list){
        const g = re.get(i);
        if (!g) continue;
        const d = ms.get(i);
        const cut2 = d ? d.cut : 0;
        const st = stretchOf(i, g, cut2);
        // 重录是随机的，两个方向都可能跑偏：漏字可能更长，语速也可能压过头
        // （实测 6 字的「是你选错了路」被压到 2.5 字/秒，retune 要提 2.0× 才追得回来，
        //  撞上 atempo 上限 1.6 反而卡在 3.9 字/秒）。
        // 所以按「离 1.00 谁更近」取舍，且必须落在 atempo 能收得回的区间里。
        const st0 = stretch0.get(i) || 99;
        const usable = st > 0 && st >= 0.75 && st <= 1.4;
        if (!usable || Math.abs(st - 1) >= Math.abs(st0 - 1) - 0.05){
          log(`第 ${i + 1} 句重录后要拉 ${st > 0 ? st.toFixed(2) : "?"}×（原 ${st0.toFixed(2)}×，1.00 是刚好），仍用原版`);
          continue;
        }
        got.set(i, g);
        if (d) first.set(i, d); else first.delete(i);
        log(`第 ${i + 1} 句重录后要拉 ${st.toFixed(2)}×（原 ${st0.toFixed(2)}×），用这一版`);
      }
    }

    // 漏字太长、长到「裁完这句就念不完」的时候，硬裁只能把正文切掉一块
    // （6 字的「人先破产吗」被 3 个字漏字压到 6.8 字/秒，就是这种情况）。
    // F5 每次采样都不一样，漏字长度是随机的，所以直接重录一版、取漏字短的那个，
    // 比在音频上动刀干净。只重录出问题的那几句，别整单重来。
    const roomOf = (i, dur) => Math.max(0, dur - (charsOf(i) / MAX_CPS) * (tempo || 1));
    for (let r = 0; r < LEAK_RETRY; r++){
      const need = [];
      for (const [i, d] of first){
        const dur = got.get(i)?.dur || 0;
        if (dur > 0 && d.cut > roomOf(i, dur) + 0.02) need.push(i);
      }
      if (!need.length) break;
      log(`第 ${need.map(i => i + 1).join("/")} 句的漏字太长（裁完会念得飞快），重录一版找漏字短的`);
      const re = await synthRound(need, `${tag}b${r + 1}`);
      const remeasure = await detectLeakOn(need.map(i => ({ i, file: re.get(i)?.file })));
      for (const i of need){
        const g = re.get(i);
        if (!g) continue;
        const d = remeasure.get(i);
        const nowCut = d ? d.cut : 0;
        const oldCut = first.get(i)?.cut ?? 0;
        // 重录是随机的，可能更差——那就还用原来那版，别为了重录把好的一版丢掉
        if (nowCut >= oldCut - 0.01){
          log(`第 ${i + 1} 句重录这版没更短（${Math.round(oldCut * 1000)}ms → ${Math.round(nowCut * 1000)}ms），仍用原版`);
          continue;
        }
        got.set(i, g);
        if (d) first.set(i, d); else first.delete(i);
        log(`第 ${i + 1} 句重录后漏字 ${Math.round(oldCut * 1000)}ms → ${Math.round(nowCut * 1000)}ms`);
      }
    }

    for (const [i, d] of first){
      const dur = got.get(i)?.dur || 0;
      const cut = Math.min(capCut(i, d.cut, dur), dur * 0.4);
      leakCuts.set(i, cut);
      if (cut > 0.04){
        log(`第 ${i + 1} 句开头多念了「${d.leak}」→ 裁掉 ${Math.round(cut * 1000)}ms`);
        if (cut < d.cut - 0.02) log(`   （检测到 ${Math.round(d.cut * 1000)}ms，再裁这句就念不完了，只裁 ${Math.round(cut * 1000)}ms）`);
      }
    }
    await shapeAll(idxList);

    // 复查：检测器本身会漏判（实测 4 句漏 1 句），裁完再看一遍
    await recheckLoop(idxList);
  };

  await runPass(allIdx, 1);

  /* 逐句拉齐语速——这一条才是「节奏」的根。
     模型给每句分配时长基本只看字数，短句天生就短；再裁掉开头那半个漏字，短句更快。
     只用一个全局系数（以前的做法）永远摆不平：实测同一批句子是 4.6 / 5.9 / 5.3 / 5.0 字/秒，
     听感就是「有的句子赶、有的句子拖」。所以按每句自己的实测语速各算一个 atempo，
     全部拉到 targetCps。
     0.75 是下限：再慢就听得出拉伸痕迹（0.55 那档实测连 whisper 都把「人先」听成「神仙」）。
     上限 1.6 同理，只是防止个别段被怪数据带跑。 */
  const retune = async (idxList) => {
    for (const i of idxList){
      const sh = shaped.get(i);
      if (!sh || sh.durMs <= 0) continue;
      const rate = charsOf(i) / (sh.durMs / 1000);
      // 注意要乘上「当前已经应用的倍数」：整形是从原始音频重做的，
      // 这里算出来的新系数必须是「相对原始音频」的绝对值，
      // 直接写 targetCps/rate 会把上一轮的拉伸丢掉，来回翻倍/减半。
      const cur = extraTempo.get(i) || 1;
      extraTempo.set(i, Math.min(1.6, Math.max(0.72, cur * targetCps / rate)));
    }
    await shapeAll(idxList);
  };
  await retune(allIdx);
  // 短句被拉慢之后时间变宽裕了，漏字残留又能再裁一遍（capCut 用的是拉伸后的口径）
  await recheckLoop(allIdx);
  await retune(allIdx);

  {
    let c = 0, s = 0;
    const det = [];
    for (const i of allIdx){
      const sh = shaped.get(i);
      if (sh && sh.durMs > 0){
        const d = sh.durMs / 1000;
        c += charsOf(i); s += d;
        det.push((charsOf(i) / d).toFixed(1));
      }
    }
    const fin = s > 0 ? c / s : 0;
    if (fin > 0.5) log(`逐句语速已拉齐到 ${fin.toFixed(1)} 字/秒（目标 ${targetCps.toFixed(1)}）· 逐句 ${det.join(" / ")}`);
  }

  /* ---------------- 抓「没念全」的段，只重渲这些 ---------------- */
  // 逐段 whisper 质检在这里是错的：1–2 秒的短音频上 faster-whisper 会大量幻觉，
  // 实测正常音频被判成覆盖率 40%（还说「多念」了 46%），于是永远不达标、无限重渲。
  // 改成看时长：字/秒 明显偏离正常区间，就是没念全或者拖音，命中才重渲。
  const RATE_LO = Number(process.env.CLONE_RATE_LO || 2.5);
  const RATE_HI = Number(process.env.CLONE_RATE_HI || 11);
  for (let pass = 2; pass <= QC_TRIES; pass++){
    if (opt.cancelled?.()) throw Object.assign(new Error("任务已取消"), { code: 499 });
    const bad = allIdx.filter(i => {
      const g = got.get(i);
      if (!g) return true;
      const r = rateOf(g);
      return r <= 0 || r > RATE_HI || r < RATE_LO;
    });
    if (!bad.length) break;
    log(`第 ${pass - 1} 轮复查：${bad.length} 段念得不正常（${bad.map(i => `第${i + 1}句 ${rateOf(got.get(i)).toFixed(1)} 字/秒`).join("、")}），重渲`);
    await runPass(bad, pass);
  }

  const missing = allIdx.filter(i => !shaped.get(i));
  if (missing.length) throw Object.assign(new Error(`有 ${missing.length} 句没合成出来（第 ${missing.map(i => i + 1).join("/")} 句）`), { code: 500 });

  /* ---------------- 拼接：段间插固定停顿 ---------------- */
  let seq = allIdx.map(i => shaped.get(i).wav);
  if (seq.length > 1 && gapMs > 0){
    const gap = path.join(work, "gap.wav");
    await must(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=mono", "-t", (gapMs / 1000).toFixed(3), gap], "生成句间停顿");
    seq = seq.flatMap((p, i) => (i ? [gap, p] : [p]));
  }
  const list = path.join(work, "concat.txt");
  fs.writeFileSync(list, seq.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf8");
  const vo = path.join(work, "clone-vo.wav");
  await must(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
    "-i", list, "-ar", "44100", "-ac", "1", vo], "拼接配音");
  const durMs = Math.round(((await probe(vo))?.duration || 0) * 1000);

  /* ---------------- 整轨质检（报告用，不触发重渲） ---------------- */
  // 整条配音转写一次再和全文比：有上下文，准确率 99%（逐段只有 40%，全是幻觉）。
  // 它只作为质量报告写进日志；真出问题靠上面的时长复查兜底，
  // 不然随便一个字同音就要重跑十分钟，用户等不起。
  let qcCov = null;
  try {
    const fullTxt = path.join(work, "full.txt");
    fs.writeFileSync(fullTxt, segs.join(""), "utf8");
    const [q] = await qcBatch([{ wav: vo, txt: fullTxt }]);
    if (q && q.cov != null) qcCov = q.cov;
  } catch(e){ log("整轨质检没跑成：" + e.message); }

  /* ---------------- 精确时间轴 ---------------- */
  // 一行一段以后，段边界就是行边界，时间轴可以直接算出来：
  // 不用再按字数去猜（按字数铺是连读时代的妥协，逐行合成之后没有任何必要）。
  const items = [];
  let cursor = 0;
  for (let i = 0; i < segs.length; i++){
    const d = shaped.get(i)?.durMs || 0;
    items.push({ i, text: segs[i], t0: cursor, t1: cursor + d });
    cursor += d + gapMs;
  }

  const report = allIdx.map(i => {
    const g = got.get(i), s = shaped.get(i);
    const outSec = (s?.durMs || 0) / 1000;
    return { i: i + 1, chars: charsOf(i), text: segs[i],
      rawSec: +(g?.dur || 0).toFixed(2), speechSec: +(g?.speech || 0).toFixed(2),
      outSec: +outSec.toFixed(2),
      // 语速按「整形后真正播出来的时长」算，跟听感一致
      cps: +(outSec > 0 ? charsOf(i) / outSec : 0).toFixed(2) };
  });
  const cps = (() => {
    let c = 0, s = 0;
    for (const r of report){ if (r.outSec > 0){ c += r.chars; s += r.outSec; } }
    return s > 0 ? +(c / s).toFixed(2) : 0;
  })();
  const rates = report.map(r => r.cps).filter(r => r > 0);
  log(`逐句语速：${rates.map(r => r.toFixed(1)).join(" / ")} 字/秒${rates.length ? `（区间 ${Math.min(...rates).toFixed(1)}–${Math.max(...rates).toFixed(1)}）` : ""}`);
  if (qcCov != null) log(`整轨质检：覆盖率 ${(qcCov * 100).toFixed(1)}%${qcCov < 0.94 ? "（偏低，个别字可能念糊了）" : ""}`);
  fs.writeFileSync(path.join(work, "clone-qc.json"), JSON.stringify({ tempo, cps, targetCps, gapMs, durMs, qcCov, report }, null, 1), "utf8");
  log(`配音节奏：${segs.length} 句 · 句间停顿 ${gapMs}ms · 总长 ${(durMs / 1000).toFixed(2)}s · 整轨 ${(segs.reduce((a, s) => a + s.replace(/\s/g, "").length, 0) / (durMs / 1000 || 1)).toFixed(2)} 字/秒`);

  const note = [`配音：本机克隆音色「${profile.name}」，未使用网站合成`];
  if (perLine) note.push(`配音逐行合成：一行一句，句间留 ${(gapMs / 1000).toFixed(2)}s 停顿`);
  return { vo, bgm: profile.bgm, durMs, items, gapMs, tempo, qcCov, note };
}
