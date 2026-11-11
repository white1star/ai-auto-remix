/**
 * 任务队列 —— 内存转状态 + SQLite 持久化。
 * 阶段键与前端 TASKS 一一对应：s1..s8。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DIRS, q, now } from "./db.mjs";
import { render } from "./render.mjs";
import { reportUsageSoon } from "./report.mjs";

export const STAGES = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
export const STAGE_NAME = {
  s1: "参考素材", s2: "配音合成", s3: "BGM 分离", s4: "分镜剪辑",
  s5: "字幕烧录", s6: "封面生成", s7: "终合成", s8: "自动质检"
};

const MAX_CONCURRENT = Math.max(1, Number(process.env.REMIX_CONCURRENCY || 1));
const live = new Map();
const queue = [];
let active = 0;

const newId = () => "j" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");

function blankStages(){
  const o = {};
  for (const k of STAGES) o[k] = "queued";
  return o;
}

export function createJob(user, cfg, origin = "web"){
  const id = newId();
  const runDir = path.join(DIRS.runs, id);
  fs.mkdirSync(runDir, { recursive: true });
  const stages = blankStages();
  const log = [{ m: `任务已创建 · 归属 ${user.username}`, k: "" }];

  q.run(`INSERT INTO jobs (id, user_id, status, origin, cfg, stages, log, run_dir, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, user.id, "running", origin, JSON.stringify(sanitizeCfg(cfg)), JSON.stringify(stages),
    JSON.stringify(log), runDir, now(), now());

  const job = { id, user_id: user.id, username: user.username, cfg, status: "running", stages, log, runDir, meta: null };
  live.set(id, job);
  queue.push(job);
  pump();
  return id;
}

function sanitizeCfg(cfg){
  const c = { ...cfg };
  delete c.uid;
  return c;
}

function pump(){
  while (active < MAX_CONCURRENT && queue.length){
    const job = queue.shift();
    active++;
    execute(job).catch(() => {}).finally(() => { active--; pump(); });
  }
}

async function execute(job){
  job.started = true;
  const persist = () => {
    try {
      q.run("UPDATE jobs SET stages=?, log=?, updated_at=? WHERE id=?",
        JSON.stringify(job.stages), JSON.stringify(job.log.slice(-200)), now(), job.id);
    } catch(e){}
  };
  const onStage = (key, status, note) => {
    // 前端约定：queued / running / ok / fail
    job.stages[key] = status === "done" ? "ok" : status;
    if (note) job.log.push({ m: `${STAGE_NAME[key]}：${note}`, k: status === "done" && /失败|跳过|缺失/.test(note) ? "warn" : "" });
    persist();
  };
  const log = m => {
    job.log.push({ m, k: /失败|错误|跳过|缺失/.test(m) ? "warn" : "" });
    if (job.log.length > 400) job.log = job.log.slice(-300);
    persist();
  };

  try {
    const out = await render(job.cfg, { runDir: job.runDir, onStage, log });
    const size = (fs.statSync(out.video).size / 1048576).toFixed(1);
    const deliverDir = path.join(DIRS.deliver, job.username || String(job.user_id), job.id);
    fs.mkdirSync(deliverDir, { recursive: true });
    for (const [src, name] of [[out.video, "video.mp4"], [out.cover, "cover.jpg"], [out.srt, "subtitle.srt"]]){
      if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(deliverDir, name));
    }

    // 用户指定了「另存到」：成片库照旧留一份（历史里能找回），再往目标目录放一套。
    // 失败不让整个任务变红——片子已经出来了，另存失败只提示。
    let savedTo = "", saveError = "";
    const wantOut = String(job.cfg.outDir || "");
    if (wantOut.includes("\uFFFD")){
      // 旧任务里可能存着乱码路径（PowerShell 回传中文路径的历史 bug），
      // 这种时候绝不能 mkdir，否则会在盘上建出「E:\AI????」这种垃圾目录。
      saveError = "保存位置含乱码字符，已跳过另存，请点「选择」重新挑一次";
      log(`另存跳过：${saveError}`);
    } else if (wantOut){
      try {
        fs.mkdirSync(wantOut, { recursive: true });
        const stem = String(job.cfg.title || "成片").replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 40)
                   + "_" + job.id.slice(-6);
        for (const [src, tail] of [[out.video, stem + ".mp4"], [out.cover, stem + "-封面.jpg"], [out.srt, stem + ".srt"]]){
          if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(wantOut, tail));
        }
        savedTo = wantOut;
        log(`已另存：${wantOut}`);
      } catch(e){
        saveError = e.message;
        log(`另存失败（不影响成片）：${e.message}`);
      }
    }

    job.meta = {
      dur: +out.duration.toFixed(2), shots: out.shots, lines: out.lines, size: +size,
      width: out.width, height: out.height, fps: out.fps,
      voice: out.voice, tts: out.ttsEngine, ttsMode: out.ttsMode, warnings: out.warnings,
      plan: out.plan ? out.plan.text : null,
      savedTo: savedTo || null, saveError: saveError || null
    };
    job.status = "done";
    job.video = `/api/file/${job.id}/video.mp4`;
    job.cover = out.cover ? `/api/file/${job.id}/cover.jpg` : null;
    job.srt = `/api/file/${job.id}/subtitle.srt`;
    job.deliverDir = deliverDir;

    q.run(`UPDATE jobs SET status='done', meta=?, video=?, cover=?, srt=?, deliver_dir=?, updated_at=? WHERE id=?`,
      JSON.stringify(job.meta), job.video, job.cover, job.srt, deliverDir, now(), job.id);
    for (const w of out.warnings) log("提示：" + w);
    log(`生成完成 · ${job.meta.dur}s · ${size}MB`);
  } catch(e){
    job.status = "error";
    job.error = String(e.message || e).slice(0, 400);
    for (const k of STAGES) if (job.stages[k] === "running") job.stages[k] = "fail";
    job.log.push({ m: "渲染失败：" + job.error, k: "er" });
    q.run("UPDATE jobs SET status='error', error=?, stages=?, log=?, updated_at=? WHERE id=?",
      job.error, JSON.stringify(job.stages), JSON.stringify(job.log.slice(-200)), now(), job.id);
  } finally {
    // 收工了就把计数报回中央（local 角色才真的发；失败无人受影响）
    reportUsageSoon();
  }
}

function shape(row, inMem){
  const stages = inMem ? row.stages : safeJson(row.stages, blankStages());
  // 服务端一次只跑一条（克隆音色一条要十几分钟），排队的任务要让前端说得出来，
  // 否则页面上就是「0% · 提交任务」一动不动，看着像卡死。
  // ahead = 正在跑的那几条 + 排在它前面的几条
  const qi = (inMem && !row.started) ? queue.findIndex(x => x.id === row.id) : -1;
  const ahead = qi >= 0 ? active + qi : -1;
  return {
    ok: true,
    id: row.id,
    status: row.status,
    queued: ahead >= 0,
    ahead: ahead >= 0 ? ahead : 0,
    stages,
    log: inMem ? row.log : safeJson(row.log, []),
    error: row.error || null,
    video: row.video || null,
    cover: row.cover || null,
    srt: row.srt || null,
    runDir: row.runDir || row.run_dir || null,
    deliver: { dir: row.deliverDir || row.deliver_dir || null },
    meta: inMem ? row.meta : safeJson(row.meta, null),
    origin: row.origin || "web",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

/** 只能拿到自己的任务 */
export function getJob(id, user){
  const mem = live.get(id);
  if (mem){
    if (mem.user_id !== user.id) return null;
    return shape(mem, true);
  }
  const row = q.get("SELECT * FROM jobs WHERE id = ? AND user_id = ?", String(id), user.id);
  if (!row) return null;
  return shape(row, false);
}

export function listJobs(user, limit = 20){
  // 从最早的作品开始编号，让「无标题」「无标题（1）」在列表刷新后保持一致。
  const rows = q.all("SELECT id, status, cfg, meta, created_at, updated_at, origin, error FROM jobs WHERE user_id = ? ORDER BY created_at ASC, id ASC", user.id);
  let untitled = 0;
  return rows.map(r => {
    let title = String(safeJson(r.cfg, {})?.title || "").trim();
    if (!title){
      title = untitled ? `无标题（${untitled}）` : "无标题";
      untitled++;
    }
    return {
      id: r.id, title,
      status: r.status, origin: r.origin, error: r.error,
      meta: safeJson(r.meta, null), created_at: r.created_at, updated_at: r.updated_at
    };
  }).slice(-Math.min(100, Math.max(1, limit))).reverse();
}

/** 只能删除自己的已结束任务；文件路径必须仍落在本机任务/成片目录。 */
export function deleteJob(id, user){
  const row = q.get("SELECT id, status, run_dir, deliver_dir FROM jobs WHERE id = ? AND user_id = ?", String(id), user.id);
  if (!row) return false;
  if (row.status === "running" || live.get(id)?.status === "running"){
    throw Object.assign(new Error("作品仍在生成，完成后再删除"), { code: 409 });
  }
  const scopedDir = (base, candidate) => {
    if (!candidate) return null;
    const dir = path.resolve(candidate), rel = path.relative(base, dir);
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel) || path.basename(dir) !== id){
      throw new Error("作品文件路径异常，未执行删除");
    }
    return dir;
  };
  const runDir = scopedDir(DIRS.runs, row.run_dir);
  const deliverDir = scopedDir(DIRS.deliver, row.deliver_dir);
  for (const dir of [runDir, deliverDir]) if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  q.run("DELETE FROM jobs WHERE id = ? AND user_id = ?", String(id), user.id);
  live.delete(id);
  return true;
}

export function latestJob(user){
  const row = q.get("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", user.id);
  if (!row) return null;
  const mem = live.get(row.id);
  return mem ? shape(mem, true) : shape(row, false);
}

/** 启动时清理：上次进程留下的 running 任务一律标记中断 */
export function recoverOnBoot(){
  const rows = q.all("SELECT id, stages FROM jobs WHERE status = 'running'");
  for (const r of rows){
    const stages = safeJson(r.stages, blankStages());
    for (const k of STAGES) if (stages[k] === "running") stages[k] = "fail";
    q.run("UPDATE jobs SET status='error', error=?, stages=?, updated_at=? WHERE id=?",
      "服务重启，任务中断", JSON.stringify(stages), now(), r.id);
  }
  if (rows.length) console.log(`[jobs] 清理中断任务 ${rows.length} 个`);
}

/** 删除任务文件（保留数据库记录用于审计） */
export function purgeJobFiles(id){
  for (const base of [DIRS.runs, DIRS.deliver]){
    const p = path.join(base, id);
    try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch(e){}
  }
}

const safeJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch(e){ return d; } };
