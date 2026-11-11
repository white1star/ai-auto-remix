/**
 * 素材层。
 *
 * 主路径是「素材路径直读」：用户在界面填一个本机文件夹，服务端直接列出来用，
 * 不复制、不上传、不占额外磁盘。服务只监听 127.0.0.1，读的就是这台机器上的文件。
 *
 * 仍然保留上传（/api/upload），作为补充：少量文件拖进来即可，不必关心放在哪。
 *
 * 隔离红线（不能被素材路径放宽）：
 *   别人上传的素材目录（DIRS.media/<别的 userId>）一律不给读，
 *   否则同机多账号之间会互相看到对方拖进来的片子。
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, q, now } from "./db.mjs";
import { isMedia, safeName, uniqName, inside, extOf, probe } from "./util.mjs";

/* BGM / 参考配音是纯音频，素材墙不收，但路径校验必须放行，
   否则 /api/generate 会把用户填的 mp3 当成「不是可用媒体文件」静默丢掉。 */
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".wma"]);
const isRefMedia = p => isMedia(p) || AUDIO_EXT.has(extOf(p));

const SHARED = (process.env.REMIX_SHARED_DIRS || "")
  .split(/[;\n]/).map(s => s.trim()).filter(Boolean);

export const sharedDirs = () => SHARED.slice();

export const userMediaDir = userId => {
  const d = path.join(DIRS.media, String(userId));
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/* ---------------- 音频库（配音 / BGM） ----------------
   配音和 BGM 由用户在 WorkBuddy 那边做好，传到这里存着，下次直接选。
   跟剪素材分开放，避免 mp3 混进素材墙被当成画面用。 */
export const userAudioDir = userId => {
  const d = path.join(DIRS.audio, String(userId));
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export function listAudios(user){
  const dir = userAudioDir(user.id);
  return fs.readdirSync(dir)
    .filter(n => AUDIO_EXT.has(extOf(n)))
    .map(n => {
      const full = path.join(dir, n);
      let st = null;
      try { st = fs.statSync(full); } catch(e){}
      return { name: n, path: full, size: st?.size || 0, mtime: st?.mtimeMs || 0 };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function saveAudioStream(user, name, stream, limit = 300 * 1024 * 1024){
  return new Promise((resolve, reject) => {
    const dir = userAudioDir(user.id);
    const clean = safeName(name);
    if (!AUDIO_EXT.has(extOf(clean))){
      stream.resume();
      return reject(Object.assign(new Error("只支持音频：" + (path.extname(clean) || "（无扩展名）")), { code: 400 }));
    }
    const final = uniqName(dir, clean);
    const full = path.join(dir, final);
    const ws = fs.createWriteStream(full);
    let size = 0, done = false;
    const bail = err => {
      if (done) return;
      done = true;
      stream.unpipe(ws); ws.destroy();
      try { fs.unlinkSync(full); } catch(e){}
      try { stream.resume(); } catch(e){}
      reject(err);
    };
    stream.on("data", c => {
      size += c.length;
      if (size > limit) bail(Object.assign(new Error("单个音频超过 300MB"), { code: 413 }));
    });
    stream.on("error", err => bail(Object.assign(new Error("接收中断：" + err.message), { code: 400 })));
    ws.on("error", err => bail(Object.assign(new Error("写入失败：" + err.message), { code: 500 })));
    ws.on("finish", () => {
      if (done) return;
      done = true;
      if (!size) { try { fs.unlinkSync(full); } catch(e){} return reject(Object.assign(new Error("文件是空的"), { code: 400 })); }
      resolve({ name: final, path: full, size });
    });
    stream.pipe(ws);
  });
}

export function deleteAudio(user, name){
  const dir = userAudioDir(user.id);
  const full = path.join(dir, safeName(String(name || "")));
  if (!inside(dir, full) || !fs.existsSync(full)) return false;
  try { fs.unlinkSync(full); return true; } catch(e){ return false; }
}

/* ---------------- 上传 ---------------- */
export function saveAsset(user, name, buf){
  const dir = userMediaDir(user.id);
  const clean = safeName(name);
  if (!isMedia(clean)) throw Object.assign(new Error("只支持视频或图片：" + path.extname(clean)), { code: 400 });
  const final = uniqName(dir, clean);
  const full = path.join(dir, final);
  fs.writeFileSync(full, buf);
  const r = q.run("INSERT INTO assets (user_id, name, path, size, source, created_at) VALUES (?,?,?,?,?,?)",
    user.id, final, full, buf.length, "upload", now());
  return { id: Number(r.lastInsertRowid), name: final, path: full, size: buf.length };
}

/**
 * 流式落盘。
 *
 * 之前是 readBody 先把整个文件读进 Node 堆再 writeFileSync —— 一个 380MB 的 4K 片段
 * 就是 380MB 常驻内存，几个一起拖直接把服务压死，前端只看到「网络错误」。
 * 现在边收边写，内存占用与文件大小无关。
 */
export function saveAssetStream(user, name, stream, limit = 1024 * 1024 * 1024){
  return new Promise((resolve, reject) => {
    const dir = userMediaDir(user.id);
    const clean = safeName(name);
    if (!isMedia(clean)){
      stream.resume();          // 不读走完，连接会一直挂着
      return reject(Object.assign(new Error("只支持视频或图片：" + (path.extname(clean) || "（无扩展名）")), { code: 400 }));
    }
    const final = uniqName(dir, clean);
    const full = path.join(dir, final);
    const ws = fs.createWriteStream(full);
    let size = 0, done = false;

    const bail = err => {
      if (done) return;
      done = true;
      stream.unpipe(ws);
      ws.destroy();
      try { fs.unlinkSync(full); } catch(e){}
      try { stream.resume(); } catch(e){}
      reject(err);
    };

    stream.on("data", c => {
      size += c.length;
      if (size > limit) bail(Object.assign(new Error("单个文件超过 1GB"), { code: 413 }));
    });
    stream.on("error", err => bail(Object.assign(new Error("接收中断：" + err.message), { code: 400 })));
    ws.on("error", err => bail(Object.assign(new Error("写入失败：" + err.message), { code: 500 })));
    ws.on("finish", () => {
      if (done) return;
      done = true;
      try {
        const r = q.run("INSERT INTO assets (user_id, name, path, size, source, created_at) VALUES (?,?,?,?,?,?)",
          user.id, final, full, size, "upload", now());
        resolve({ id: Number(r.lastInsertRowid), name: final, path: full, size });
      } catch(e){
        try { fs.unlinkSync(full); } catch(_){}
        reject(Object.assign(new Error("入库失败：" + e.message), { code: 500 }));
      }
    });

    stream.pipe(ws);
  });
}

export function listAssets(user){
  return q.all("SELECT id, name, path, size, created_at FROM assets WHERE user_id = ? ORDER BY id DESC", user.id)
    .map(a => ({ ...a, url: "/api/media?path=" + encodeURIComponent(a.path) }));
}

export function deleteAsset(user, { id, name }){
  const row = id
    ? q.get("SELECT * FROM assets WHERE id = ? AND user_id = ?", Number(id), user.id)
    : q.get("SELECT * FROM assets WHERE name = ? AND user_id = ? ORDER BY id DESC LIMIT 1", String(name || ""), user.id);
  if (!row) return false;
  try { if (fs.existsSync(row.path)) fs.unlinkSync(row.path); } catch(e){}
  q.run("DELETE FROM assets WHERE id = ?", row.id);
  return true;
}

export function assetByPath(user, p){
  return q.get("SELECT * FROM assets WHERE user_id = ? AND path = ?", user.id, samePath(p));
}

const samePath = p => path.resolve(String(p || ""));

/* ---------------- 路径鉴权 ---------------- */
/** 是不是别人拖进来的素材（DIRS.media/<别人的 id>/…） */
function othersUpload(p){
  if (!inside(DIRS.media, p)) return false;
  const rel = path.relative(path.resolve(DIRS.media), path.resolve(p));
  const top = rel.split(path.sep)[0];
  return !!top && /^\d+$/.test(top);
}

/**
 * 返回 { ok:true, path } 或 { ok:false, code, error }
 *
 * 放行顺序：
 *   1. 自己上传的素材（assets 表里有记录）
 *   2. 自己的素材目录 / 共享素材盘
 *   3. 本机任意位置的媒体文件 —— 素材路径直读，workbuddy 填哪就读哪
 * 唯一的拒绝：别人上传目录里的东西。
 */
export function resolveMediaPath(user, raw, opt = {}){
  if (!raw) return { ok: false, code: 400, error: "缺少 path" };
  let p;
  try { p = path.resolve(String(raw)); } catch(e){ return { ok: false, code: 400, error: "路径不合法" }; }

  // 参考素材（BGM / 配音）允许纯音频；普通素材仍只收视频+图片
  const allowed = opt.allowAudio ? isRefMedia(p) : isMedia(p);
  if (!allowed) return { ok: false, code: 400, error: "不是可用的媒体文件" };

  // 别人拖进来的素材，任何情况都不给
  if (othersUpload(p) && !inside(userMediaDir(user.id), p))
    return { ok: false, code: 403, error: "无权访问该文件" };

  if (assetByPath(user, p)) return stat(p);
  if (inside(userMediaDir(user.id), p)) return stat(p);
  for (const d of SHARED) if (inside(d, p)) return stat(p);

  return stat(p);
}

function stat(p){
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { ok: false, code: 404, error: "文件不存在" };
    return { ok: true, path: p, size: st.size, mtime: st.mtimeMs };
  } catch(e){
    return { ok: false, code: 404, error: "文件不存在" };
  }
}

/** 校验一批素材路径是否都能用，返回可用列表 */
export function checkBatch(user, files){
  const good = [], bad = [];
  for (const f of (files || [])){
    const r = resolveMediaPath(user, f);
    if (r.ok) good.push(r.path); else bad.push({ path: f, error: r.error });
  }
  return { good, bad };
}

/* ---------------- 素材路径（列目录） ---------------- */
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);

/**
 * 列出素材路径下的视频与图片。
 *
 * 不再要求「必须在共享盘内」——用户在界面填什么路径就列什么，
 * 填错了就明确说填错在哪（不存在 / 不是文件夹 / 不可读），
 * 而不是丢一句「不在共享素材盘内」让人摸不着头脑。
 */
export async function listDir(user, dir){
  const raw = String(dir || "").trim();
  if (!raw) return { dirFiles: [], notice: "没填素材路径" };

  let target;
  try { target = path.resolve(raw); } catch(e){ return { dirFiles: [], notice: "路径不合法" }; }

  let st;
  try { st = fs.statSync(target); }
  catch(e){ return { dirFiles: [], notice: "路径不存在：" + target }; }
  if (!st.isDirectory()) return { dirFiles: [], notice: "这不是文件夹：" + target };

  // 别人上传的素材目录不给列（同机多账号隔离）
  if (othersUpload(target) && !inside(userMediaDir(user.id), target))
    return { dirFiles: [], notice: "该目录是别人的素材区，无权查看" };

  const out = [];
  try {
    for (const name of fs.readdirSync(target)){
      if (!isMedia(name)) continue;
      const full = path.join(target, name);
      let fst; try { fst = fs.statSync(full); } catch(e){ continue; }
      if (!fst.isFile()) continue;
      out.push({
        name, path: full, size: fst.size,
        kind: IMG_EXT.has(extOf(name)) ? "image" : "video",
        mtime: fst.mtimeMs
      });
    }
  } catch(e){
    return { dirFiles: [], notice: "目录读不了（权限或占用）：" + target };
  }

  out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  if (!out.length) return { dirFiles: [], notice: "这个文件夹里没有视频或图片" };
  return { dirFiles: out };
}

/** 同步版本，给 MCP 解析「传个文件夹」用；规则与 listDir 一致 */
export function readMediaDir(user, dir){
  const target = path.resolve(String(dir || ""));
  let st;
  try { st = fs.statSync(target); } catch(e){ return { ok: false, error: "路径不存在" }; }
  if (!st.isDirectory()) return { ok: false, error: "这不是文件夹" };
  if (othersUpload(target) && !inside(userMediaDir(user.id), target))
    return { ok: false, error: "该目录是别人的素材区，无权查看" };

  const files = [];
  try {
    for (const name of fs.readdirSync(target)){
      if (!isMedia(name)) continue;
      const full = path.join(target, name);
      try { if (fs.statSync(full).isFile()) files.push(full); } catch(e){}
    }
  } catch(e){
    return { ok: false, error: "目录读不了（权限或占用）" };
  }
  files.sort((a, b) => a.localeCompare(b, "zh"));
  if (!files.length) return { ok: false, error: "这个文件夹里没有视频或图片" };
  return { ok: true, files };
}

/** 生成前预检素材，顺便补时长信息给前端 */
export async function describeForClient(user){
  const rows = q.all("SELECT id, name, path, size FROM assets WHERE user_id = ? ORDER BY id DESC", user.id);
  const out = [];
  for (const r of rows){
    if (!fs.existsSync(r.path)) continue;
    // ffprobe 会把 jpg/png 也报成视频流，类型必须以扩展名为准
    const isImg = IMG_EXT.has(path.extname(r.path).toLowerCase());
    const p = isImg ? null : await probe(r.path);
    out.push({
      id: r.id, name: r.name, path: r.path, size: r.size,
      kind: isImg ? "image" : "video",
      duration: p?.hasVideo ? +p.duration.toFixed(2) : 0,
      url: "/api/media?path=" + encodeURIComponent(r.path)
    });
  }
  return out;
}
