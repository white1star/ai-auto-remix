/**
 * 参考视频 → 克隆配音 + BGM。五步全自动，一条命令。
 *
 *   1 拿片      dl-link.mjs    参考链接 → 本机 mp4（抖音反爬走无头 Chrome 截真实地址）
 *   2 分离      sep-any.py     HDEMUCS 拆人声/伴奏，伴奏留作 BGM
 *   3 参考段    sep-any.py     50ms RMS 滑窗挑 12 秒最密人声 + 转写参考文本
 *   4 克隆      clone-tts.py   用参考音色念新文案（数字/缩写先归一化）
 *   5 质检拼接  qc-seg.py      逐段转写比对，丢字自动重渲 → ffmpeg concat
 *
 * 用法:
 *   node dub.mjs <参考链接|-> <文案.txt> [--speed 1.2] [--nfe 16] [--voice KEY]
 *                [--out 目录] [--no-desktop] [--rebuild]
 *   node dub.mjs --doctor          环境体检
 *   node dub.mjs --voices          列出音色档案
 *   node dub.mjs --set-default K   设默认音色
 *
 * 关键环境变量:
 *   F5_HOME      F5 权重目录（含 model_1250000.safetensors + vocab.txt + vocos）
 *   VOICES_HOME  音色档案目录，默认 ~/.workbuddy/voices
 *   PY312        装了 f5-tts/torch 的 Python 3.12
 *   PY313        装了 faster-whisper/pypinyin 的 Python 3.13
 *   FFMPEG/FFPROBE/CHROME  按需覆盖
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, "..");
const SC = path.join(SKILL, "scripts");
const VOICES = process.env.VOICES_HOME || path.join(os.homedir(), ".workbuddy", "voices");

/**
 * 找「项目根」：一是本机的 ai-auto-remix 开发目录，二是技能被拷进交付包之后的包根。
 * 两者都带 runtime\ffmpeg.exe 和（可能）weights\f5，所以一起当候选。
 */
function projectRoots(){
  const out = [];
  const push = p => { try { if (fs.statSync(p).isDirectory() && !out.includes(p)) out.push(p); } catch(e){} };
  for (const base of [path.join(os.homedir(), "WorkBuddy"), path.join(os.homedir(), "Desktop")]){
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch(e){ continue; }
    for (const d of dirs){
      const p = path.join(base, d, "ai-auto-remix");
      if (fs.existsSync(p)) push(p);
    }
  }
  // 技能装在 <包根>/connector/skills/voice-clone-dub 时，向上逐级找带 runtime/ffmpeg.exe
  // 或 weights/f5 的目录——交付包里这两样本来就是齐的，不用用户再配环境变量。
  let cur = SKILL;
  for (let i = 0; i < 6; i++){
    cur = path.dirname(cur);
    if (cur === path.dirname(cur)) break;
    if (["runtime/ffmpeg.exe", "runtime/ffmpeg", "weights/f5", ".workbuddy/clone/f5"]
          .some(rel => fs.existsSync(path.join(cur, rel.split("/").join(path.sep))))) push(cur);
  }
  return out;
}
const PROJECTS = projectRoots();

/**
 * 解释器解析：PY312/PY313 环境变量 → <包根>/runtime/python312（交付包提示词让装的位置）
 * → 本机默认路径。少了这一步，同事按提示词把 Python 装进包里，网页能用、
 * 命令行 --doctor 却说「缺 Python」，两边对不上。
 */
function findPy(envKey, sub, fallback){
  const v = process.env[envKey];
  if (v) return v;
  for (const root of PROJECTS){
    const cand = path.join(root, "runtime", sub, "python.exe");
    if (fs.existsSync(cand)) return cand;
  }
  if (fs.existsSync(fallback)) return fallback;
  return "python";
}
const PY312 = findPy("PY312", "python312", path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe"));
const PY313 = findPy("PY313", "python313", path.join(os.homedir(), ".workbuddy", "binaries", "python", "versions", "3.13.12", "python.exe"));

/** exe 解析：环境变量 → PATH → 项目 runtime */
function findExe(envKey, exeName){
  const v = process.env[envKey];
  if (v) return v;
  const p = spawnSync(exeName, ["-version"], { encoding: "utf8" });
  if (!p.error && p.status === 0) return exeName;
  for (const root of PROJECTS){
    const cand = path.join(root, "runtime", exeName + ".exe");
    if (fs.existsSync(cand)) return cand;
  }
  return exeName;
}
const FFMPEG = findExe("FFMPEG", "ffmpeg");
const FFPROBE = findExe("FFPROBE", "ffprobe");
const QC_MIN = Number(process.env.QC_MIN || 0.96);
const QC_HEAD = Number(process.env.QC_HEAD || 0.9);
const QC_TRIES = Number(process.env.QC_TRIES || 3);
const SEG_MAX = Number(process.env.SEG_MAX || 60);

const log = (...a) => console.log(new Date().toLocaleTimeString("zh-CN"), ...a);

/* ---------------- 环境 ---------------- */
/** F5 权重：F5_HOME → 技能目录 weights/f5 → 本机已下好的（项目里的，省得再下 1.3GB） */
function findF5(){
  const ok = d => fs.existsSync(path.join(d, "model_1250000.safetensors")) && fs.existsSync(path.join(d, "vocab.txt"));
  const cand = [];
  if (process.env.F5_HOME) cand.push(process.env.F5_HOME);
  cand.push(path.join(SKILL, "weights", "f5"));
  for (const root of PROJECTS){
    cand.push(path.join(root, "weights", "f5"));
    cand.push(path.join(root, ".workbuddy", "clone", "f5"));
  }
  return cand.find(ok) || null;
}

function run(cmd, args, label, opts = {}){
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${label} 起不来：${r.error.message}`);
  if (r.status !== 0){
    const msg = ((r.stderr || "") + (r.stdout || "")).trim().split("\n").slice(-6).join("\n");
    throw new Error(`${label} 失败（${r.status}）：${msg}`);
  }
  return { out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const probe = f => Number(run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], "探测时长").out) || 0;

/* ---------------- 音色档案 ---------------- */
const keyOf = url => crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 12);

function readProfile(dir){
  const metaFile = path.join(dir, "meta.json");
  if (!fs.existsSync(metaFile) || !fs.existsSync(path.join(dir, "ref.wav"))) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    return { dir, meta, ref: path.join(dir, "ref.wav"),
      refText: fs.existsSync(path.join(dir, "ref.txt")) ? fs.readFileSync(path.join(dir, "ref.txt"), "utf8").trim() : "",
      bgm: fs.existsSync(path.join(dir, "bgm.mp3")) ? path.join(dir, "bgm.mp3") : null };
  } catch(e){ return null; }
}
const findVoice = url => readProfile(path.join(VOICES, keyOf(url)));
const findVoiceByKey = k => (k ? readProfile(path.join(VOICES, k)) : null);
const defaultKey = () => {
  try { return JSON.parse(fs.readFileSync(path.join(VOICES, "default.json"), "utf8")).key || ""; }
  catch(e){ return ""; }
};

/* ---------------- 五步 ---------------- */
/** 1+2+3：参考链接 → 音色档案（ref.wav / ref.txt / bgm.mp3） */
async function buildProfile(url, scriptText, work){
  const key = keyOf(url);
  const dir = path.join(VOICES, key);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(work, "profile_tmp");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  log("[1/5] 下载参考片（抖音反爬，约 10–20 秒）");
  run(process.execPath, [path.join(SC, "dl-link.mjs"), url, tmp, "src.mp4"], "下载参考视频");
  const media = path.join(tmp, "src.mp4");
  if (!fs.existsSync(media)) throw new Error("下载后没拿到视频文件");

  log("[2/5] 分离人声与伴奏（HDEMUCS，约 1 分钟）");
  run(PY312, [path.join(SC, "sep-any.py"), media, tmp], "人声分离");

  log("[3/5] 挑参考段 + 转写参考文本");
  fs.copyFileSync(path.join(tmp, "ref_seg.wav"), path.join(dir, "ref.wav"));
  run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", path.join(tmp, "bgm.wav"),
               "-b:a", "192k", path.join(dir, "bgm.mp3")], "导出伴奏");

  const scriptFile = path.join(tmp, "script.txt");
  fs.writeFileSync(scriptFile, scriptText || "", "utf8");
  const asr = run(PY313, [path.join(SC, "asr-seg.py"), path.join(dir, "ref.wav"),
                          path.join(dir, "ref.txt"), scriptFile], "参考段转写");
  if (!asr.out || asr.out.length < 4) throw new Error("参考段转写为空");

  const span = JSON.parse(fs.readFileSync(path.join(tmp, "ref_span.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    source: url, key, span: [span.start, span.end], dur: span.dur,
    refTextVerified: false,
    note: "ref.txt 是自动转写草稿；同音字请人工改一遍再标志 refTextVerified: true",
    created_at: new Date().toISOString()
  }, null, 1), "utf8");
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`      音色档案已建：${dir}（参考段 ${span.dur.toFixed(2)}s）`);
  return readProfile(dir);
}

/** 按标点切段，跟网站那边同规则 */
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

function qcOne(wav, txt){
  const r = spawnSync(PY313, [path.join(SC, "qc-seg.py"), wav, txt],
                      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  try { return JSON.parse(line); } catch(e){ return null; }
}

/** 4+5：逐段克隆 + 逐段质检 + 拼接 */
function render(profile, script, opt, work){
  const segs = splitScript(script);
  const parts = [], report = [];
  // F5 的 speed 是「压目标时长」，压太紧会直接丢句首（实测 1.2 丢 6 个字、1.0 全对）。
  // 所以一律按原生语速 1.0 生成，再用 ffmpeg atempo 变速——保音高，不丢字。
  const tempo = Math.min(2.0, Math.max(0.5, Number(opt.speed) || 1));
  log(`[4/5] 克隆合成：${script.length} 字 → ${segs.length} 段，nfe=${opt.nfe}，原生语速生成${tempo !== 1 ? `后 atempo ${tempo}x` : ""}`);
  for (let i = 0; i < segs.length; i++){
    const base = `seg_${String(i).padStart(2, "0")}`;
    const txt = path.join(work, base + ".txt");
    fs.writeFileSync(txt, segs[i], "utf8");
    let best = null;
    for (let attempt = 1; attempt <= QC_TRIES; attempt++){
      const raw = path.join(work, `${base}_a${attempt}_raw.wav`);
      const out = path.join(work, `${base}_a${attempt}.wav`);
      run(PY312, [path.join(SC, "clone-tts.py"), "--ref", profile.ref, "--ref-text", profile.refText,
                  "--gen-text", segs[i], "--out", raw,
                  "--nfe", String(opt.nfe), "--speed", "1.0"], `第 ${i + 1} 段合成`);
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
      if (!best || (cov + head) > (best.cov + best.head)) best = { out, cov, head };
      if (cov >= QC_MIN && head >= QC_HEAD) break;
      const why = head < QC_HEAD ? `段首只念出 ${(head * 100).toFixed(0)}%`
                                 : `只念出 ${(cov * 100).toFixed(0)}%（丢：${qc.missing || "?"}）`;
      log(`      第 ${i + 1} 段${why}，重渲第 ${attempt + 1} 次`);
    }
    parts.push(best.out);
    report.push({ i: i + 1, chars: segs[i].length, cov: best.cov, head: best.head });
    log(`      段 ${i + 1}/${segs.length}  ${segs[i].length} 字  覆盖 ${(best.cov * 100).toFixed(0)}%  段首 ${(best.head * 100).toFixed(0)}%`);
  }

  log("[5/5] 拼接成片");
  // 段间插 300ms 静音：网站按配音里的停顿对齐字幕（停顿 >180ms 才算句界），
  // 段与段直接硬接会没有可识别的停顿，字幕只能按字数铺。
  const list = path.join(work, "concat.txt");
  let seq = parts;
  if (parts.length > 1){
    const gap = path.join(work, "gap.wav");
    run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                 "-i", "anullsrc=r=44100:cl=mono", "-t", "0.30", gap], "生成段间停顿");
    seq = parts.flatMap((p, i) => (i ? [gap, p] : [p]));
  }
  fs.writeFileSync(list, seq.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf8");
  const vo = path.join(work, "vo.wav");
  run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
               "-i", list, "-ar", "44100", "-ac", "1", vo], "拼接配音");
  const low = report.filter(r => r.cov < QC_MIN || r.head < QC_HEAD);
  fs.writeFileSync(path.join(work, "qc.json"), JSON.stringify(report, null, 1), "utf8");
  if (low.length) log(`      注意：${low.length} 段未达标（${low.map(r => r.i).join(",")}），已重试 ${QC_TRIES} 次`);
  return { vo, report, low };
}

/* ---------------- 命令 ---------------- */
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const has = n => argv.includes(n);

if (has("--doctor")){
  // 每一行单独兜住异常：缺 Python / 解释器指错时，应该打印「不可用：…」，
  // 而不是甩一段 Node 堆栈给同事看
  const probe = (cmd, args, label) => {
    try { return run(cmd, args, label).out.split("\n")[0].slice(0, 90); }
    catch(e){ return "不可用：" + String(e.message).split("\n")[0].slice(0, 70); }
  };
  const f5 = findF5();
  const ff = probe(FFMPEG, ["-version"], "ffmpeg");
  const py312 = probe(PY312, ["-c", "import torch;print('torch', torch.__version__)"], "py312");
  const py313 = probe(PY313, ["-c", "import faster_whisper;print('faster-whisper ok')"], "py313");
  const rows = [
    ["F5 权重", f5 || "缺（设 F5_HOME 或下到 skills/voice-clone-dub/weights/f5）"],
    ["音色目录", VOICES + (fs.existsSync(VOICES) ? "" : "（还没建）")],
    ["默认音色", defaultKey() || "未设"],
    ["FFmpeg", ff],
    ["Python3.12", py312],
    ["Python3.13", py313],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(10)} ${v}`);
  const bad = !f5 || [ff, py312, py313].some(v => String(v).startsWith("不可用"));
  process.exit(bad ? 1 : 0);
}

if (has("--voices")){
  const keys = fs.existsSync(VOICES) ? fs.readdirSync(VOICES).filter(k => fs.existsSync(path.join(VOICES, k, "meta.json"))) : [];
  const dk = defaultKey();
  console.log(`音色档案目录 ${VOICES}`);
  if (!keys.length) console.log("  （空。第一次用某个参考链接会自动建）");
  for (const k of keys){
    const p = readProfile(path.join(VOICES, k));
    if (p) console.log(`  ${k}  ${p.meta.name || "未命名"}  ${p.meta.dur ? p.meta.dur.toFixed(1) + "s" : ""}${p.meta.refTextVerified ? " 文本已校订" : " 文本未校订"}${k === dk ? "  ← 默认" : ""}`);
  }
  process.exit(0);
}

if (has("--set-default")){
  const k = flag("--set-default");
  const p = findVoiceByKey(k);
  if (!p){ console.error(`没有这个音色档案: ${k || "(空)"}`); process.exit(2); }
  fs.writeFileSync(path.join(VOICES, "default.json"), JSON.stringify({
    key: k, name: p.meta.name || "", source: p.meta.source || "", set_at: new Date().toISOString()
  }, null, 1), "utf8");
  console.log(`默认音色 → ${k}（${p.meta.name || ""}）`);
  process.exit(0);
}

const [src, scriptFile] = argv.filter(a => !a.startsWith("--"));
if (!src || !scriptFile || !fs.existsSync(scriptFile)){
  console.error("用法: node dub.mjs <参考链接|-> <文案.txt> [--speed 1.2] [--nfe 16] [--voice KEY] [--out 目录]");
  console.error("      - 表示用默认音色，不下载新参考片");
  process.exit(2);
}

const script = fs.readFileSync(scriptFile, "utf8").trim();
const opt = { speed: Number(flag("--speed", 1.2)), nfe: Number(flag("--nfe", 16)) };
const work = path.resolve(flag("--out", path.join(SKILL, "out")),
                          new Date().toISOString().replace(/[-:]/g, "").slice(0, 13));
fs.mkdirSync(work, { recursive: true });

const f5 = findF5();
if (!f5) throw new Error("找不到 F5 权重。设 F5_HOME 指向含 model_1250000.safetensors 的目录");
process.env.F5_HOME = f5;

const t0 = Date.now();
let profile = null;
if (src === "-"){
  const dk = flag("--voice", defaultKey());
  profile = findVoiceByKey(dk);
  if (!profile) throw new Error(`没有默认音色（${dk || "未设"}）。先用一个参考链接建一次，或 --voice <key>`);
  log(`[1-3/5] 跳过下载分离，用默认音色 ${dk}（${profile.meta.name || "未命名"}）`);
} else {
  profile = has("--rebuild") ? null : findVoice(src);
  if (profile) log(`[1-3/5] 复用已有音色档案 ${path.basename(profile.dir)}（${profile.meta.refTextVerified ? "文本人工校订" : "ASR 草稿"}）`);
  else profile = await buildProfile(src, script, work);
}
if (!profile.refText) throw new Error("音色档案缺 ref.txt，克隆没法对齐韵律");

const { vo, report, low } = render(profile, script, opt, work);
const dur = probe(vo);
const dest = path.join(work, "配音.wav");
fs.copyFileSync(vo, dest);

if (!has("--no-desktop")){
  const desk = path.join(os.homedir(), "Desktop", `克隆配音-${path.basename(work)}.wav`);
  try { fs.copyFileSync(vo, desk); log(`      已放桌面 ${desk}`); } catch(e){ log(`      桌面拷贝失败：${e.message}`); }
}
if (profile.bgm){
  const bgm = path.join(work, "伴奏.mp3");
  fs.copyFileSync(profile.bgm, bgm);
  log(`      BGM ${bgm}`);
}

log(`完成 ${Math.round((Date.now() - t0) / 1000)}s · 配音 ${dur.toFixed(2)}s · 覆盖 ${report.map(r => r.cov.toFixed(2)).join("/")}`);
log(`输出 ${work}`);
if (low.length) process.exit(3);
