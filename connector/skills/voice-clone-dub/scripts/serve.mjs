/**
 * 网站后台音频助手 —— 领单 → 准备音色/BGM → 合成配音 → 拼接 → 回填 vo_file / bgm_file。
 *
 * 配音引擎（VOICE_ENGINE 环境变量或命令行开关）：
 *   clone  默认。F5-TTS 零样本克隆，用默认音色的原声念新文案。
 *          每段合成完自动转写质检，覆盖率不到 96% 自动重渲。
 *          274 字约 12 分钟（本机只有 CPU，无独显）。
 *   edge   --edge 切过去。微软 edge-tts 预设音色，274 字约 10 秒，
 *          但**不是原声**，回填的 note 会如实写明。
 *
 * 默认音色：.workbuddy/voices/default.json 里的 key 指向一个音色档案，
 * 设了之后任务里带的参考链接不再改音色；要跟着链接走设 VOICE_FOLLOW_URL=1。
 *
 * 音色档案（.workbuddy/voices/<key>/）第一次用到某个参考链接时自动建：
 *   ref.wav    干净人声片段（10–12 秒，HDEMUCS 分离后挑最密的一段）
 *   ref.txt    这段人声说的话（clone 引擎才会转写；edge 模式跳过）
 *   bgm.mp3    同一来源分离出的伴奏
 *   meta.json  来源、时间跨度、是否人工校订
 * 之后所有任务直接复用，不再重复下载和分离。
 *
 * 用法:
 *   node scripts/serve.mjs                             持续接单（默认音色克隆）
 *   node scripts/serve.mjs --once                      只处理一条
 *   node scripts/serve.mjs --edge                      改走预设音色（快）
 *   node scripts/serve.mjs --local <链接> <文案.txt>     本地跑一条，不碰网站
 *   node scripts/serve.mjs --local - <文案.txt>         用默认音色跑一条
 *   node scripts/serve.mjs --defaults                  看当前默认音色
 *   node scripts/serve.mjs --set-default <key>         改默认音色
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SC = HERE;                       // 技能自带的脚本目录（dl-link / sep-any / clone-tts …）
const SKILL = path.resolve(HERE, ".."); // 技能根

/**
 * 包根：从技能目录向上逐级找带 runtime/ffmpeg.exe 的目录。
 * 技能随包放在 <包根>/connector/skills/voice-clone-dub 时就是包根；
 * 单独装在 ~/.workbuddy/skills/ 下时找不到，退回技能根，靠 PATH 里的 ffmpeg。
 */
function findRoot(){
  let cur = SKILL;
  for (let i = 0; i < 6; i++){
    cur = path.dirname(cur);
    if (cur === path.dirname(cur)) break;
    if (fs.existsSync(path.join(cur, "runtime", "ffmpeg.exe"))) return cur;
  }
  return SKILL;
}
const ROOT = findRoot();
const BASE = process.env.REMIX_BASE || "http://127.0.0.1:8765";
const TOKEN_FILE = process.env.MCP_TOKEN_FILE || path.join(ROOT, ".workbuddy", "mcp-token.txt");
/** 令牌懒读：--local / --dry 不碰网站，没有令牌也要能跑 */
function mcpToken(){
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); }
  catch(e){ return ""; }
}
// 解释器解析：环境变量 → 包内 runtime/python312|python313（提示词让装的位置）→ 本机默认
const pickPy = (envKey, sub, fallback) =>
  process.env[envKey]
  || [path.join(ROOT, "runtime", sub, "python.exe"), path.join(SKILL, "runtime", sub, "python.exe")].find(p => fs.existsSync(p))
  || fallback;
const P312 = pickPy("PY312", "python312", path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe"));
const P313 = pickPy("PY313", "python313", path.join(os.homedir(), ".workbuddy", "binaries", "python", "versions", "3.13.12", "python.exe"));
const pickExe = (rel, fallback) =>
  [path.join(ROOT, rel), path.join(SKILL, rel)].find(p => fs.existsSync(p)) || fallback;
const FFMPEG = process.env.FFMPEG || pickExe(path.join("runtime", "ffmpeg.exe"), "ffmpeg");
const FFPROBE = process.env.FFPROBE || pickExe(path.join("runtime", "ffprobe.exe"), "ffprobe");
const NODE = pickExe(path.join("runtime", "node.exe"), process.execPath);
const VOICES = process.env.VOICES_HOME || path.join(os.homedir(), ".workbuddy", "voices");
const ONCE = process.argv.includes("--once");
const SEG_MAX = Number(process.env.SEG_MAX || 60);

/**
 * F5 权重目录。clone-tts.py 靠 F5_HOME 找模型，所以这里解析好就必须写回环境变量，
 * 否则子进程会退回「技能目录/weights/f5」而报「缺 主模型」。
 * 顺序：F5_HOME → 包根 weights/f5 → 技能 weights/f5 → 本机开发目录里已下好的。
 */
function findF5(){
  const ok = d => fs.existsSync(path.join(d, "model_1250000.safetensors")) && fs.existsSync(path.join(d, "vocab.txt"));
  const cand = [];
  if (process.env.F5_HOME) cand.push(process.env.F5_HOME);
  cand.push(path.join(ROOT, "weights", "f5"), path.join(SKILL, "weights", "f5"));
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
const F5 = findF5();
if (F5) process.env.F5_HOME = F5;

/* 配音引擎：默认 clone（用默认音色克隆，慢但声音对），--edge 切微软预设音色（秒级） */
const ENGINE = (process.env.VOICE_ENGINE || (process.argv.includes("--edge") ? "edge" : "clone")).toLowerCase();
const EDGE_VOICE = process.env.EDGE_VOICE || "zh-CN-YunjianNeural";
const EDGE_BIN = pickExe(path.join("runtime", "edge-tts", "edge-tts.exe"), "edge-tts");

const log = (...a) => console.log(new Date().toLocaleTimeString("zh-CN"), ...a);

/* ---------------- MCP ---------------- */
let seq = 0;
async function rpc(method, params){
  const TOKEN = mcpToken();
  if (!TOKEN) throw new Error(`缺 MCP 令牌：设 MCP_TOKEN 或把令牌写进 ${TOKEN_FILE}`);
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": "Bearer " + TOKEN
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params })
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 160)}`);
  const line = raw.includes("data:")
    ? raw.split("\n").filter(l => l.startsWith("data:")).pop().slice(5).trim()
    : raw;
  const j = JSON.parse(line);
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}
async function callTool(name, args){
  const r = await rpc("tools/call", { name, arguments: args });
  const text = (r?.content || []).map(c => c.text).join("\n");
  let data = null;
  try { data = JSON.parse(text); } catch(e){}
  return { isError: !!r?.isError, text, data };
}

function run(cmd, args, label){
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0){
    const msg = (r.stderr || r.stdout || "").trim().split("\n").slice(-6).join("\n");
    throw new Error(`${label} 失败（${r.status}）：${msg}`);
  }
  return { out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
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

/* ---------------- 音色档案 ---------------- */
const keyOf = url => crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 12);

function readProfile(dir){
  if (!fs.existsSync(path.join(dir, "meta.json"))) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    if (!fs.existsSync(path.join(dir, "ref.wav"))) return null;
    return { dir, meta,
      ref: path.join(dir, "ref.wav"),
      refText: fs.existsSync(path.join(dir, "ref.txt")) ? fs.readFileSync(path.join(dir, "ref.txt"), "utf8").trim() : "",
      bgm: fs.existsSync(path.join(dir, "bgm.mp3")) ? path.join(dir, "bgm.mp3") : null };
  } catch(e){ return null; }
}

function findVoiceByKey(key){
  if (!key || !fs.existsSync(VOICES)) return null;
  return readProfile(path.join(VOICES, key));
}

function findVoice(url){
  if (!fs.existsSync(VOICES)) return null;
  const p = readProfile(path.join(VOICES, keyOf(url)));
  return p && p.meta.source === url ? p : null;
}

/* 默认音色：写在 .workbuddy/voices/default.json，老板定的「以后都用这个声音」 */
const DEFAULT_FILE = path.join(VOICES, "default.json");
function defaultVoice(){
  try {
    const j = JSON.parse(fs.readFileSync(DEFAULT_FILE, "utf8"));
    return j.key ? findVoiceByKey(j.key) : null;
  } catch(e){ return null; }
}
/* 默认音色优先：任务里带的参考链接不再改变音色；想跟着链接走设 VOICE_FOLLOW_URL=1 */
const FOLLOW_URL = !!process.env.VOICE_FOLLOW_URL;

/** 第一次见到这个参考链接：下载 → 分离 → 挑段 → 转写 → 存档 */
async function buildVoice(url, scriptText, note, skipAsr = false){
  const key = keyOf(url);
  const dir = path.join(VOICES, key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "_tmp");
  fs.mkdirSync(tmp, { recursive: true });

  await note("首次遇到这个参考链接，正在下载（约 10–20 秒）");
  run(NODE, [path.join(SC, "dl-link.mjs"), url, tmp, "src.mp4"], "下载参考视频");
  const media = path.join(tmp, "src.mp4");
  if (!fs.existsSync(media)) throw new Error("下载后没拿到视频文件");

  await note("分离人声与伴奏（HDEMUCS，约 1 分钟）");
  run(P312, [path.join(SC, "sep-any.py"), media, tmp], "人声分离");

  fs.copyFileSync(path.join(tmp, "ref_seg.wav"), path.join(dir, "ref.wav"));
  run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error",
               "-i", path.join(tmp, "bgm.wav"), "-b:a", "192k", path.join(dir, "bgm.mp3")], "导出伴奏");

  const span = JSON.parse(fs.readFileSync(path.join(tmp, "ref_span.json"), "utf8"));
  if (skipAsr){
    // edge 模式下不克隆，ref.txt 用不上，省掉一次 large-v3 转写（约 40 秒）
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
      source: url, key, span: [span.start, span.end], dur: span.dur,
      refTextVerified: false,
      note: "edge 模式建的档案：只取伴奏和人声片段，未转写参考文本",
      created_at: new Date().toISOString()
    }, null, 1), "utf8");
    fs.rmSync(tmp, { recursive: true, force: true });
    return { dir, ref: path.join(dir, "ref.wav"), refText: "",
             bgm: path.join(dir, "bgm.mp3"), meta: { refTextVerified: false } };
  }

  await note("转写参考段（用来对齐韵律）");
  const scriptFile = path.join(tmp, "script.txt");
  fs.writeFileSync(scriptFile, scriptText || "", "utf8");
  const r = run(P313, [path.join(SC, "asr-seg.py"),
                       path.join(dir, "ref.wav"), path.join(dir, "ref.txt"), scriptFile], "参考段转写");
  if (!r.out || r.out.length < 4) throw new Error("参考段转写为空");
  if (r.err) log("  " + r.err.replace(/\n/g, " | "));

  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    source: url, key, span: [span.start, span.end], dur: span.dur,
    refTextVerified: false,
    note: "ref.txt 是自动转写草稿；同音字可通过 dev/audio-agent.mjs --verify 或手改后使用",
    created_at: new Date().toISOString()
  }, null, 1), "utf8");
  fs.rmSync(tmp, { recursive: true, force: true });

  return { dir, ref: path.join(dir, "ref.wav"),
           refText: fs.readFileSync(path.join(dir, "ref.txt"), "utf8").trim(),
           bgm: path.join(dir, "bgm.mp3"), meta: { refTextVerified: false } };
}

/* ---------------- F5 克隆渲染 + 质检 ---------------- */
const QC_MIN = Number(process.env.QC_MIN || 0.96);
const QC_HEAD = Number(process.env.QC_HEAD || 0.9);
const QC_TRIES = Number(process.env.QC_TRIES || 3);

/** 转写一段并与期望文案比覆盖率。念全的段实测 1.000，丢字的段 0.86 左右 */
function qcOne(wav, txt){
  const r = spawnSync(P313, [path.join(SC, "qc-seg.py"), wav, txt],
                      { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  try { return JSON.parse(line); } catch(e){ return null; }
}

/**
 * 逐段克隆：一段一检，覆盖率不到 QC_MIN 就重渲（F5 每次采样不同，重来常常就对了）。
 * 返回拼好的 vo.wav。
 */
async function cloneRender(req, voice, work, note){
  if (!F5) throw new Error("找不到 F5 权重：把它放到包根 weights/f5（含 model_1250000.safetensors + vocab.txt + vocos），或设 F5_HOME 指向已有目录");
  if (!voice.meta.refTextVerified) log("  注意：参考文本是 ASR 草稿，同音字可能影响效果");
  if (!voice.refText) throw new Error("音色档案里没有参考文本，克隆没法对齐韵律");
  const segs = splitScript(req.script);
  const est = Math.ceil(req.script.length * 2.6 / 60);
  await note(`开始克隆配音：${req.script.length} 字 / ${segs.length} 段，预计约 ${est} 分钟（含质检）`);

  // F5 的 speed 是「压目标时长」，压太紧会直接丢句首（实测 1.2 丢 6 字、1.0 全对）。
  // 所以一律按原生语速生成，再用 ffmpeg atempo 变速——保音高，不丢字。
  const tempo = Math.min(2.0, Math.max(0.5, Number(req.speed) || 1));

  const parts = [], report = [];
  for (let i = 0; i < segs.length; i++){
    const base = `seg_${String(i).padStart(2, "0")}`;
    const txt = path.join(work, base + ".txt");
    fs.writeFileSync(txt, segs[i], "utf8");
    let best = null;
    for (let attempt = 1; attempt <= QC_TRIES; attempt++){
      const raw = path.join(work, `${base}_a${attempt}_raw.wav`);
      const out = path.join(work, `${base}_a${attempt}.wav`);
      run(P312, [path.join(SC, "clone-tts.py"),
                 "--ref", voice.ref, "--ref-text", voice.refText,
                 "--gen-text", segs[i], "--out", raw,
                 "--nfe", String(req.nfe || 16), "--speed", "1.0"],
          `第 ${i + 1} 段合成`);
      if (!fs.existsSync(raw)) throw new Error(`第 ${i + 1} 段没有产出音频`);
      if (tempo !== 1){
        run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", raw,
                     "-filter:a", `atempo=${tempo}`, "-ar", "44100", "-ac", "1", out], `第 ${i + 1} 段变速`);
      } else {
        fs.copyFileSync(raw, out);
      }
      const qc = qcOne(out, txt);
      const cov = qc ? qc.cov : 1;
      const head = qc && qc.head != null ? qc.head : 1;
      const ok = cov >= QC_MIN && head >= QC_HEAD;
      if (!best || (cov + head) > (best.cov + best.head)) best = { out, cov, head, qc };
      if (ok) break;
      const why = head < QC_HEAD ? `段首只念出 ${(head * 100).toFixed(0)}%` : `只念出 ${(cov * 100).toFixed(0)}%（丢：${qc.missing || "?"}）`;
      log(`  第 ${i + 1} 段${why}，重渲第 ${attempt + 1} 次`);
    }
    parts.push(best.out);
    report.push({ i: i + 1, chars: segs[i].length, cov: best.cov, head: best.head });
    await note(`配音 ${i + 1}/${segs.length} 完成（${segs[i].length} 字，覆盖率 ${(best.cov * 100).toFixed(0)}%，段首 ${(best.head * 100).toFixed(0)}%）`);
  }

  const list = path.join(work, "concat.txt");
  // 段间插 300ms 静音：网站按配音里的停顿对齐字幕（>180ms 才算句界），
  // 段与段硬接会没有可识别的停顿，字幕只能退化成按字数铺。
  let seq = parts;
  if (parts.length > 1){
    const gap = path.join(work, "gap.wav");
    run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                 "-i", "anullsrc=r=44100:cl=mono", "-t", "0.30", gap], "生成段间停顿");
    seq = parts.flatMap((p, i) => (i ? [gap, p] : [p]));
  }
  fs.writeFileSync(list, seq.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf8");
  const voOut = path.join(work, "vo.wav");
  run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
               "-i", list, "-ar", "44100", "-ac", "1", voOut], "拼接配音");
  const low = report.filter(r => r.cov < QC_MIN || r.head < QC_HEAD);
  log(`  质检：${report.map(r => `${r.cov.toFixed(2)}/${r.head.toFixed(2)}`).join(" ")}${low.length ? `（${low.length} 段仍不达标）` : " 全部达标"}`);
  fs.writeFileSync(path.join(work, "qc.json"), JSON.stringify(report, null, 1), "utf8");
  return voOut;
}

/* ---------------- 单条处理 ---------------- */
/** 只做音频：准备档案 → 合成配音 → 导出 BGM。与 MCP 无关，方便 --dry 自测 */
async function buildAudio(req, note){
  const id = req.id;
  const work = path.join(ROOT, ".workbuddy", "audio-work", id);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const urls = [...new Set([req.useVoice ? req.voiceUrl : "", req.useBgm ? req.bgmUrl : ""].filter(Boolean))];

  // 克隆模式下先看有没有「默认音色」。有就直接用，任务里带的链接不再改音色
  const def = ENGINE === "clone" ? defaultVoice() : null;
  const wantDefault = !!def && !FOLLOW_URL;
  if (wantDefault) log(`  默认音色 ${path.basename(def.dir)}（${def.meta.name || "未命名"}）`);

  if (!wantDefault && !urls.length) throw new Error("任务里没有可用的参考链接，也没设默认音色");

  // 每个来源先拿到「档案」（有就复用，没有才建）。edge 模式不克隆，省掉转写那一步
  const profiles = new Map();
  for (const u of urls){
    const needVoice = req.useVoice && u === req.voiceUrl && !wantDefault;
    const needBgm = req.useBgm && u === req.bgmUrl;
    if (!needVoice && !needBgm){ log(`  跳过 ${u}（默认音色已就位，无需它的档案）`); continue; }
    const hit = findVoice(u);
    if (hit){ log(`  复用音色档案 ${path.basename(hit.dir)}（${hit.meta.refTextVerified ? "人工校订" : "ASR 草稿"}）`); profiles.set(u, hit); }
    else { await note("准备音色档案"); profiles.set(u, await buildVoice(u, req.script, note, ENGINE !== "clone")); }
  }

  const voice = wantDefault ? def : (req.useVoice ? profiles.get(req.voiceUrl) : null);
  const bgmSrc = req.useBgm ? (profiles.get(req.bgmUrl) || def) : null;

  let voOut = null;
  if (ENGINE === "edge"){
    /* edge：整段一次合成。逐句拼会一句一句往外蹦（server/tts.mjs 里踩过） */
    const mp3 = path.join(work, "vo.mp3");
    const txt = path.join(work, "script.txt");
    // edge 能自己念数字，不用做中文读法归一化；只有「40%+」这种会被念成
    // 「百分之四十 加」，换成「以上」更顺
    const say = String(req.script).replace(/[%％]\s*\+/g, "％以上");
    fs.writeFileSync(txt, say, "utf8");
    const pct = Math.round((Number(req.speed || 1) - 1) * 100);
    const args = ["-f", txt, "-v", EDGE_VOICE, "--write-media", mp3, "--no-progress"];
    if (pct) args.push(`--rate=${pct > 0 ? "+" : ""}${pct}%`);
    await note(`合成配音：${req.script.length} 字 · 预设音色 ${EDGE_VOICE} · ${req.speed || 1}x（未做原声克隆）`);
    let lastErr = "";
    for (let i = 0; i < 3; i++){
      if (i) await new Promise(r => setTimeout(r, 2500));
      const r = spawnSync(EDGE_BIN, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (r.status === 0 && fs.existsSync(mp3) && fs.statSync(mp3).size > 2000) { lastErr = ""; break; }
      lastErr = ((r.stderr || "") + (r.stdout || "")).trim().split("\n").slice(-3).join(" | ");
    }
    if (lastErr) throw new Error("edge-tts 合成失败：" + lastErr);
    voOut = path.join(work, "vo.wav");
    run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error",
                 "-i", mp3, "-ar", "44100", "-ac", "1", voOut], "转 wav");
  } else if (voice){
    /* F5 克隆：按段合成 + 逐段质检，丢字就重渲 */
    voOut = await cloneRender(req, voice, work, note);
  }

  /* BGM */
  let bgmOut = null;
  if (bgmSrc){
    await note("导出 BGM");
    if (!bgmSrc.bgm) throw new Error("这个参考来源没有分离出伴奏");
    bgmOut = path.join(work, "bgm.mp3");
    fs.copyFileSync(bgmSrc.bgm, bgmOut);
  }

  return { voOut, bgmOut, work };
}

/* ---------------- 领单并回填 ---------------- */
async function processRequest(req, claimToken){
  const id = req.id;
  const t0 = Date.now();
  const note = async m => {
    try { await callTool("finish_audio_request", { request_id: id, claim_token: claimToken, note: String(m).slice(0, 200) }); }
    catch(e){ log("  note 失败:", e.message); }
    log("  " + m);
  };

  const { voOut, bgmOut } = await buildAudio(req, note);

  const payload = { request_id: id, claim_token: claimToken };
  if (voOut) payload.vo_file = voOut;
  if (bgmOut) payload.bgm_file = bgmOut;
  if (!payload.vo_file && !payload.bgm_file) throw new Error("没有产出任何音频");
  const done = await callTool("finish_audio_request", payload);
  if (done.isError) throw new Error("回填被拒：" + done.text.slice(0, 300));
  log(`完成 ${id} · ${Math.round((Date.now() - t0) / 1000)}s · ${voOut ? "配音" : ""}${bgmOut ? "+BGM" : ""}`);
}

/* ---------------- 主循环 ---------------- */
const defArg = process.argv.indexOf("--defaults");
if (defArg > -1){
  const d = defaultVoice();
  if (!d){ console.log("未设默认音色。用 --set-default <key> 指定，key 就是 .workbuddy/voices 下的目录名"); process.exit(0); }
  console.log(`默认音色  ${path.basename(d.dir)}`);
  console.log(`  名称    ${d.meta.name || "未命名"}`);
  console.log(`  来源    ${d.meta.source || "-"}`);
  console.log(`  参考段  ${d.meta.dur ? d.meta.dur.toFixed(2) + "s" : "-"}${d.meta.refTextVerified ? "（文本人工校订）" : "（文本未校订）"}`);
  console.log(`  BGM     ${d.bgm ? "已备" : "无"}`);
  const all = fs.existsSync(VOICES) ? fs.readdirSync(VOICES).filter(k => fs.existsSync(path.join(VOICES, k, "meta.json"))) : [];
  console.log(`\n全部音色档案（${all.length} 个）`);
  for (const k of all){
    const p = readProfile(path.join(VOICES, k));
    if (p) console.log(`  ${k}  ${p.meta.name || "未命名"}${d && k === path.basename(d.dir) ? "  ← 默认" : ""}`);
  }
  process.exit(0);
}

const setDefArg = process.argv.indexOf("--set-default");
if (setDefArg > -1){
  const key = process.argv[setDefArg + 1];
  const p = findVoiceByKey(key);
  if (!p){ console.error(`没有这个音色档案: ${key || "(空)"}`); process.exit(2); }
  fs.writeFileSync(DEFAULT_FILE, JSON.stringify({
    key, name: p.meta.name || "", source: p.meta.source || "",
    engine: "clone",
    note: "老板定的默认男声：" + (p.meta.note || ""),
    set_at: new Date().toISOString()
  }, null, 1), "utf8");
  console.log(`默认音色已改为 ${key} · ${p.meta.name || ""}`);
  process.exit(0);
}

const localArg = process.argv.indexOf("--local");
if (localArg > -1){
  // 一条命令跑完整流程：参考视频链接 + 文案 → 音轨分离 → 克隆 → 质检 → 成片
  const url = process.argv[localArg + 1];
  const scriptFile = process.argv[localArg + 2];
  if (!url || !scriptFile || !fs.existsSync(scriptFile)){
    console.error("用法: node scripts/serve.mjs --local <参考视频链接|-> <文案.txt> [--speed 1.2]");
    process.exit(2);
  }
  const spArg = process.argv.indexOf("--speed");
  const speed = spArg > -1 ? Number(process.argv[spArg + 1]) : 1.2;
  const script = fs.readFileSync(scriptFile, "utf8").trim();
  const work = path.join(ROOT, ".workbuddy", "audio-work", "local-" + Date.now());
  fs.mkdirSync(work, { recursive: true });
  const note = async m => log("  " + m);
  const t0 = Date.now();
  try {
    let voice = null;
    if (url === "-"){
      voice = defaultVoice();
      if (!voice) throw new Error("没设默认音色，也没给参考链接");
      log(`  用默认音色 ${path.basename(voice.dir)}（${voice.meta.name || "未命名"}）`);
    } else {
      voice = findVoice(url);
      if (voice) log(`  复用音色档案 ${path.basename(voice.dir)}（${voice.meta.refTextVerified ? "人工校订" : "ASR 草稿"}）`);
      else voice = await buildVoice(url, script, note, false);
    }
    const vo = await cloneRender({ script, speed }, voice, work, note);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
    const dest = path.join(process.env.USERPROFILE || ROOT, "Desktop", `克隆配音-${stamp}.wav`);
    fs.copyFileSync(vo, dest);
    const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", vo], { encoding: "utf8" });
    log(`完成 ${Math.round((Date.now() - t0) / 1000)}s · 时长 ${Number((r.stdout || "0").trim()).toFixed(2)}s → ${dest}`);
  } catch(e){
    log("失败: " + e.message);
    process.exit(1);
  }
  process.exit(0);
}

const dryArg = process.argv.indexOf("--dry");
if (dryArg > -1){
  // 不碰网站，纯本地跑一遍音频链路，用来核对音色/时长/BGM 是否正常
  const f = process.argv[dryArg + 1];
  if (!f || !fs.existsSync(f)) { console.error("用法: --dry <文案.txt>"); process.exit(2); }
  const script = fs.readFileSync(f, "utf8").trim();
  const req = {
    id: "dry-" + Date.now(), script,
    speed: Number(process.env.DRY_SPEED || 1.2),
    useVoice: true, useBgm: true,
    voiceUrl: process.env.DRY_VOICE_URL || "https://v.douyin.com/7Re9tO-ufJs/",
    bgmUrl: process.env.DRY_VOICE_URL || "https://v.douyin.com/7Re9tO-ufJs/"
  };
  const t0 = Date.now();
  const { voOut, bgmOut } = await buildAudio(req, async m => log("  " + m));
  const dur = voOut ? Number((await new Promise(res => {
    const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", voOut], { encoding: "utf8" });
    res((r.stdout || "0").trim() || 0);
  }))) : 0;
  log(`自测完成 ${Math.round((Date.now() - t0) / 1000)}s · 配音 ${dur.toFixed(2)}s → ${voOut} · BGM ${bgmOut ? "有" : "无"}`);
  process.exit(0);
}

const verifyArg = process.argv.indexOf("--verify");
if (verifyArg > -1){
  // 手工校订某个音色档案的参考文本（改完永久生效）
  const key = process.argv[verifyArg + 1];
  const dir = path.join(VOICES, key || "");
  if (!key || !fs.existsSync(path.join(dir, "ref.txt"))) { console.error("用法: --verify <key>"); process.exit(2); }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  meta.refTextVerified = true;
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 1), "utf8");
  console.log("已标记为人工校订:", path.join(dir, "ref.txt"));
  process.exit(0);
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "audio-agent", version: "1" }
});

/* 新版网站的契约：同事在网页点「生成视频」→ 复制一条带任务号的指令 → 粘贴给我。
   这时必须用 request_id 精确领取那一条（wait_seconds 传 0），不能顺手领别的。 */
const claimArg = process.argv.indexOf("--claim");
if (claimArg > -1){
  const rid = process.argv[claimArg + 1];
  if (!/^a[0-9a-f]{32}$/.test(String(rid || ""))){
    console.error("用法: node scripts/serve.mjs --claim a<32位任务号>");
    process.exit(2);
  }
  const r = await callTool("wait_audio_request", { wait_seconds: 0, request_id: rid });
  const data = r.data;
  if (!data || !data.request){
    log(`没领到任务 ${rid}：可能已处理、已取消或不属于当前账号`);
    process.exit(4);
  }
  const { request, claim_token } = data;
  log(`领到 ${request.id} · ${request.script.length} 字 · 配音=${request.useVoice} BGM=${request.useBgm} · ${request.speed}x`);
  try {
    await processRequest(request, claim_token);
  } catch(e){
    log("失败:", e.message);
    try {
      await callTool("finish_audio_request", {
        request_id: request.id, claim_token, error: String(e.message).slice(0, 500)
      });
      log("  已回填错误");
    } catch(e2){ log("  回填失败:", e2.message); }
    process.exit(1);
  }
  process.exit(0);
}

log(`后台音频助手已就绪（配音引擎 ${ENGINE}${ENGINE === "edge" ? " · " + EDGE_VOICE : " · F5 克隆"}），等待网站任务…`);

process.on("SIGINT", () => { log("停止"); process.exit(0); });

while (true){
  try {
    const r = await callTool("wait_audio_request", { wait_seconds: 45 });
    const data = r.data;
    if (!data || !data.request){
      if (ONCE){ log("没有待处理任务"); break; }
      continue;
    }
    const { request, claim_token } = data;
    log(`领到 ${request.id} · ${request.script.length} 字 · 配音=${request.useVoice} BGM=${request.useBgm} · ${request.speed}x`);
    try {
      await processRequest(request, claim_token);
    } catch(e){
      log("失败:", e.message);
      try {
        await callTool("finish_audio_request", {
          request_id: request.id, claim_token, error: String(e.message).slice(0, 500)
        });
        log("  已回填错误");
      } catch(e2){ log("  回填失败:", e2.message); }
    }
    if (ONCE) break;
  } catch(e){
    log("轮询出错:", e.message);
    await new Promise(r => setTimeout(r, 5000));
  }
}
