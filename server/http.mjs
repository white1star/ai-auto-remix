/**
 * HTTP 层 —— 兼容旧前端接口，同时提供账号 / Token / 管理员 / 文件下载。
 * 所有资源访问都经过 currentUser + 归属校验，前端传的 uid 一律忽略。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { q, now, audit, DIRS } from "./db.mjs";
import * as A from "./auth.mjs";
import * as M from "./media.mjs";
import * as J from "./jobs.mjs";
import { fetchVideoLink } from "./fetchlink.mjs";
import { sendJson, ok, fail, sendText, readJson, readBody, probe, run } from "./util.mjs";
import { parseMultipart } from "./multipart.mjs";
import { detectEngine, VOICES } from "./tts.mjs";
import { handleMcpHttp } from "./mcp.mjs";
import * as AR from "./audio-requests.mjs";
import { listCloneVoices, cloneReadiness, findCloneVoice } from "./clone.mjs";
import { cloudStatus, findCloudVoice, renderCloudPreview, previewFile } from "./cloudvoice.mjs";
import { ROLE, isCentral, isLocal, isStandalone } from "./role.mjs";
import { publicKeyPem, verifyTicket } from "./ticket.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SESSION_SEC = 12 * 3600;

/**
 * 自助注册开关。三层优先级：
 *   1. 环境变量 REMIX_ALLOW_REGISTER=0 —— 硬关，本地也改不回来（给运维兜底）
 *   2. 库里 settings.register_open —— 管理员在 /admin 点一下立即生效，不用重启
 *   3. 都没设置时默认开启（内网办公场景，员工自己建号最省事）
 */
function registerOpen(){
  if (process.env.REMIX_ALLOW_REGISTER === "0") return false;
  const row = q.get("SELECT value FROM settings WHERE key = 'register_open'");
  if (row) return row.value === "1";
  return true;
}

/** 渲染类接口在 standalone / local 才有 */
const CAN_RENDER = isStandalone || isLocal;
/** 账号管理类接口在 standalone / central 才有 */
const CAN_MANAGE = isStandalone || isCentral;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".srt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".wav": "audio/wav", ".mp3": "audio/mpeg"
};

const clientIp = req =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";

/**
 * 中央：员工本机代理过来的请求没有浏览器 cookie，用「会话票据」认人。
 *
 * 只认 kind=session —— 不接受拿 api 令牌去换新令牌（否则一条泄露的令牌
 * 就能无限续期，等于永不失效）。session 票据是网页登录当场换来的，可信。
 */
function bearerSessionUser(req){
  if (!isCentral) return null;
  const raw = String(req.headers.authorization || "");
  const tk = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
  if (!tk) return null;
  const v = verifyTicket(tk, publicKeyPem());
  if (!v.ok || v.payload.kind !== "session") return null;
  const u = q.get("SELECT * FROM users WHERE uuid = ?", v.payload.uuid);
  return u && !u.disabled ? u : null;
}

/**
 * 本机把请求原样转给中央（目前用于令牌）。
 * 身份用当前会话绑定的那张票据；不转发浏览器 cookie —— 跨域带不过去，也不该带。
 */
async function proxyToCentral(req, res, p){
  const sid = A.readCookie(req, "sid");
  const row = sid ? q.get("SELECT ticket FROM sessions WHERE token_hash = ?", A.sha256(sid)) : null;
  if (!row || !row.ticket) return fail(res, 401, "会话已过期，请重新登录");

  const opt = {
    method: req.method,
    headers: { authorization: "Bearer " + row.ticket },
    signal: AbortSignal.timeout(12000)
  };
  if (req.method === "POST"){
    const b = await readJson(req).catch(() => ({}));
    opt.headers["content-type"] = "application/json";
    opt.body = JSON.stringify(b || {});
  }

  try {
    const r = await fetch(new URL(p, A.CENTRAL_URL), opt);
    const j = await r.json().catch(() => ({}));
    return sendJson(res, r.status, j);
  } catch(e){
    return fail(res, 502, "连不上公司账号服务，请检查网络后重试");
  }
}

export async function handler(req, res){
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const ip = clientIp(req);

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");

  try {
    /* ---------- MCP ---------- */
    if (p === "/mcp") return await handleMcpHttp(req, res, url);

    /* ---------- 静态 ---------- */
    // 中央角色没有工作台，根路径直接进账号管理
    if (req.method === "GET" && (p === "/" || p === "/index.html")){
      if (isCentral){
        res.writeHead(302, { Location: "/admin" });
        return res.end();
      }
      if (!CAN_RENDER) return fail(res, 404, "本服务不提供工作台");
      return serveFile(req, res, path.join(ROOT, "index.html"));
    }
    if (req.method === "GET" && (p === "/admin" || p === "/admin.html")){
      if (!CAN_MANAGE) return fail(res, 404, "账号管理只在中央服务提供");
      return serveFile(req, res, path.join(ROOT, "admin.html"));
    }
    if (req.method === "GET" && /^\/(assets|static)\//.test(p)) {
      const f = path.join(ROOT, p);
      if (f.startsWith(ROOT)) return serveFile(req, res, f);
    }

    /* ---------- 鉴权 ---------- */
    if (p === "/api/auth/config" && req.method === "GET"){
      const n = q.get("SELECT COUNT(*) AS n FROM users").n;

      // 本机不持有账号库，开不开注册得问中央，否则界面上会摆一个点了就报错的页签
      if (isLocal){
        const c = await A.centralConfig();
        return ok(res, {
          role: ROLE,
          allowRegister: !!c.allowRegister,
          canRegisterHere: !!c.canRegisterHere,
          firstUser: false,
          tokenTtlDays: 90,
          users: n,
          central: A.CENTRAL_URL || null
        });
      }

      const open = registerOpen();
      return ok(res, {
        role: ROLE,
        allowRegister: open,
        canRegisterHere: open,
        firstUser: open && n === 0,
        tokenTtlDays: 90,
        users: n,
        central: A.CENTRAL_URL || null
      });
    }

    // 本机来验签用的公钥（公开信息，不含私钥）
    if (p === "/api/auth/pubkey" && req.method === "GET"){
      if (!CAN_MANAGE) return fail(res, 404, "该接口不在本服务角色中");
      return ok(res, { pubkey: publicKeyPem(), alg: "ed25519" });
    }

    // 本机查询令牌是否已被中央吊销
    if (p === "/api/auth/token-status" && req.method === "GET"){
      if (!CAN_MANAGE) return fail(res, 404, "该接口不在本服务角色中");
      const jti = url.searchParams.get("jti") || "";
      return sendJson(res, 200, A.tokenStatus(jti));
    }

    /**
     * 员工本机回传作品数。
     * 用中央签发的 report 票据认账（不占用户会话），只收数字，别的字段一律忽略。
     */
    if (p === "/api/report/usage" && req.method === "POST"){
      if (!isCentral) return fail(res, 404, "该接口不在本服务角色中");

      const raw = String(req.headers.authorization || "");
      const tk = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
      if (!tk) return fail(res, 401, "缺少上报凭证");

      const v = verifyTicket(tk, publicKeyPem());
      if (!v.ok) return fail(res, 401, "上报凭证无效：" + v.error);
      if (v.payload.kind !== "report") return fail(res, 401, "凭证类型不对");

      const owner = q.get("SELECT * FROM users WHERE uuid = ?", v.payload.uuid);
      if (!owner) return fail(res, 401, "账号不存在");
      if (owner.disabled) return fail(res, 401, "账号已被停用");

      const b = await readJson(req);
      const n = x => Math.max(0, Math.min(1e9, Math.floor(Number(x) || 0)));
      const machine = String(b.machine || "unknown").slice(0, 64);

      q.run(`INSERT INTO usage (machine, ext_uuid, username, jobs, done, assets, updated_at)
             VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(machine, ext_uuid) DO UPDATE SET
               username = excluded.username, jobs = excluded.jobs, done = excluded.done,
               assets = excluded.assets, updated_at = excluded.updated_at`,
        machine, v.payload.uuid, owner.username, n(b.jobs), n(b.done), n(b.assets), now());

      return ok(res, { machine, at: now() });
    }

    if (p === "/api/auth/register" && req.method === "POST"){
      const b = await readJson(req);

      // 本机：账号库在中央，注册要转给中央建号，再把人和票据一起领回来
      if (isLocal){
        const r = await A.registerViaCentral(b.username, b.password, ip, req.headers["user-agent"]);
        if (r.error) return fail(res, r.status || 400, r.error);
        res.setHeader("Set-Cookie", A.sessionCookie(r.token, SESSION_SEC));
        return ok(res, { user: r.user, role: ROLE, ticket: r.ticket });
      }

      if (!CAN_MANAGE) return fail(res, 403, "注册请到公司账号服务进行");
      if (!registerOpen()) return fail(res, 403, "管理员已关闭自主注册");
      const ue = A.validateUsername(b.username); if (ue) return fail(res, 400, ue);
      const pe = A.validatePassword(b.password); if (pe) return fail(res, 400, pe);
      if (q.get("SELECT id FROM users WHERE username = ?", String(b.username).trim()))
        return fail(res, 409, "该用户名已被占用");
      const isFirst = q.get("SELECT COUNT(*) AS n FROM users").n === 0;
      const id = A.createUser(b.username, b.password);
      audit(id, "user.register", b.username, ip);
      const user = q.get("SELECT * FROM users WHERE id = ?", id);
      const sess = A.login(user.username, b.password, ip, req.headers["user-agent"]);
      if (sess.error) return ok(res, { user: A.publicUser(user), firstUser: isFirst, needLogin: true });
      res.setHeader("Set-Cookie", A.sessionCookie(sess.token, SESSION_SEC));
      // ticket 给本机验签用：员工在自己电脑上注册，本机要能立刻认下这个人
      return ok(res, {
        user: A.publicUser(user), firstUser: isFirst,
        ticket: sess.ticket || null, reportTicket: sess.reportTicket || null
      });
    }

    if (p === "/api/auth/login" && req.method === "POST"){
      const b = await readJson(req);
      const r = isLocal
        ? await A.loginViaCentral(b.username, b.password, ip, req.headers["user-agent"])
        : A.login(b.username, b.password, ip, req.headers["user-agent"]);
      if (r.error) return fail(res, 401, r.error);
      res.setHeader("Set-Cookie", A.sessionCookie(r.token, SESSION_SEC));
      // 本机靠这张签名票据认身份，中央必须把它交出去
      return ok(res, {
        user: r.user, role: ROLE,
        ticket: r.ticket || null,
        // 长效「上报凭证」：本机后台报作品数用，不需要用户一直挂着会话
        reportTicket: r.reportTicket || null
      });
    }

    if (p === "/api/auth/logout" && req.method === "POST"){
      const t = A.readCookie(req, "sid");
      A.logout(t);
      res.setHeader("Set-Cookie", A.clearCookie());
      return ok(res, {});
    }

    /* ---------- 之后全部需要身份 ---------- */
    const user = await A.currentUser(req);
    const need = () => fail(res, 401, "请先登录");

    if (p === "/api/auth/me"){
      if (!user) return fail(res, 401, "未登录");
      const t = A.readCookie(req, "sid");
      return ok(res, {
        user: A.publicUser(user),
        role: ROLE,
        via: t ? "session" : "token",
        expiresIn: t ? sessionExpiry(t) : null,
        tts: CAN_RENDER ? await detectEngine() : null
      });
    }

    /* ---------- 渲染类接口（standalone / local） ---------- */
    if (!CAN_RENDER && /^\/api\/(materials|media|upload|delete_upload|assets|generate|job|jobs|file)/.test(p))
      return fail(res, 404, "该接口不在本服务角色中");

    /* ---------- 兼容旧接口 ---------- */
    if (p === "/api/whoami"){
      if (!user) return need();
      return ok(res, { name: user.username, id: user.id, role: user.role });
    }

    if (p === "/api/rename" && req.method === "POST"){
      if (!user) return need();
      const b = await readJson(req);
      return ok(res, { name: user.username, note: "账号名称由登录身份决定，不支持前端改名：" + (b.name || "") });
    }

    if (p === "/api/session"){
      if (!user) return need();
      return ok(res, { sid: "u" + user.id });
    }

    if (p === "/api/latest"){
      if (!user) return need();
      const j = J.latestJob(user);
      return j ? ok(res, j) : ok(res, { none: true });
    }

    if (p === "/api/materials"){
      if (!user) return need();
      const dir = url.searchParams.get("dir") || "";
      const uploads = await M.describeForClient(user);
      const { dirFiles, notice } = await M.listDir(user, dir);
      return ok(res, { uploads, dirFiles, notice, shared: M.sharedDirs() });
    }

    if (p === "/api/media" && req.method === "GET"){
      if (!user) return need();
      const r = M.resolveMediaPath(user, url.searchParams.get("path"));
      if (!r.ok) return fail(res, r.code, r.error);
      return serveFile(req, res, r.path);
    }

    if (p === "/api/upload" && req.method === "POST"){
      if (!user) return need();
      const ctype = req.headers["content-type"] || "";
      const saved = [];

      // 原生二进制上传（大文件走这条）：?name=xxx.mp4，边收边写盘
      if (!ctype.includes("multipart/")){
        const name = url.searchParams.get("name");
        if (!name) return fail(res, 400, "缺少 name 参数");
        try { saved.push(await M.saveAssetStream(user, name, req)); }
        catch(e){ return fail(res, e.code || 500, e.message); }
      } else {
        let buf;
        try { buf = await readBody(req, 600 * 1024 * 1024); }
        catch(e){ return fail(res, 413, "单次上传超过 600MB，请改用逐个上传或直接填素材路径"); }
        const mp = parseMultipart(buf, ctype);
        if (!mp) return fail(res, 400, "表单解析失败");
        for (const f of mp.files){
          if (!f.filename) continue;
          try { saved.push(M.saveAsset(user, f.filename, f.data)); }
          catch(e){ return fail(res, e.code || 500, `${f.filename}：${e.message}`); }
        }
      }
      if (!saved.length) return fail(res, 400, "没有收到文件");
      audit(user.id, "asset.upload", saved.map(s => s.name).join(","), ip);
      return ok(res, { files: saved, saved, count: saved.length });
    }

    if (p.startsWith("/api/delete_upload/") && req.method === "POST"){
      if (!user) return need();
      // 路由形如 /api/delete_upload/{sid}/{文件名}：
      // 前 3 段是空串+api+delete_upload，第 4 段是 sid，从第 5 段起才是文件名。
      // 之前 slice(3) 把 sid 一起拼进名字，按名查询永远落空，删除从不生效。
      const name = decodeURIComponent(p.split("/").slice(4).join("/"));
      const done = M.deleteAsset(user, { name });
      if (done) audit(user.id, "asset.delete", name, ip);
      return ok(res, { deleted: done });
    }

    if (p === "/api/assets" && req.method === "GET"){
      if (!user) return need();
      return ok(res, { assets: M.listAssets(user) });
    }

    if (p.startsWith("/api/assets/") && req.method === "DELETE"){
      if (!user) return need();
      const id = Number(p.split("/").pop());
      const done = M.deleteAsset(user, { id });
      if (done) audit(user.id, "asset.delete", "id=" + id, ip);
      return done ? ok(res, {}) : fail(res, 404, "素材不存在");
    }

    /* 网站发单；WorkBuddy 通过 MCP 领取并回填 */
    if (p === "/api/assistant/status" || p === "/api/audio/requests" || p.startsWith("/api/audio/requests/")) {
      if (!CAN_RENDER) return fail(res, 404, "本服务不处理音频任务");
      if (!user) return need();
      if (p === "/api/assistant/status" && req.method === "GET") return ok(res, AR.assistantStatus(user));
      if (p === "/api/audio/requests" && req.method === "POST") return ok(res, {request: AR.createAudioRequest(user, await readJson(req, 128 * 1024))});
      if (p === "/api/audio/requests" && req.method === "GET") return ok(res, {request: AR.latestAudioRequest(user)});
      const id = p.split("/")[4];
      if (req.method === "GET") return ok(res, {request: AR.getAudioRequest(user, id)});
      if (req.method === "DELETE") return ok(res, {request: AR.cancelAudioRequest(user, id)});
      return fail(res, 405, "不支持的音频任务操作");
    }

    /* ---------- 本机克隆音色（不依赖 WorkBuddy） ---------- */
    if (p === "/api/clone/voices" && req.method === "GET"){
      if (!user) return need();
      const ready = cloneReadiness();
      return ok(res, {
        voices: listCloneVoices(),
        ready: ready.ok,
        missing: ready.missing,
        engine: ready.engine || "f5",
        provider: ready.provider || ""
      });
    }

    /* ---------- 网页云端配音：音色清单 + 效果试听 ----------
       凭证只在服务端（~/.workbuddy/voices/.cloud-key.json），这里只回状态和音色 ID。 */
    if (p === "/api/cloud/voices" && req.method === "GET"){
      if (!user) return need();
      return ok(res, cloudStatus());
    }
    if (p === "/api/cloud/preview" && req.method === "POST"){
      if (!user) return need();
      const b = await readJson(req).catch(() => ({}));
      try {
        const r = await renderCloudPreview(String(b.text || ""), String(b.voice || ""), Number(b.speed || 1));
        audit(user.id, "cloud.preview", `${r.id} · ${b.voice || "default"}`, ip);
        return ok(res, r);
      } catch(e){
        return fail(res, e.code || 502, e.message || "试听合成失败");
      }
    }
    if (p === "/api/cloud/preview" && req.method === "GET"){
      if (!user) return need();
      const f = previewFile(url.searchParams.get("id"));
      if (!f) return fail(res, 404, "试听音频不存在");
      return serveFile(req, res, f);
    }

    /* ---------- 音频库（配音 / BGM） ---------- */
    if (p === "/api/audio/list" && req.method === "GET"){
      if (!user) return need();
      return ok(res, { audios: M.listAudios(user) });
    }

    if (p === "/api/audio/upload" && req.method === "POST"){
      if (!user) return need();
      const name = url.searchParams.get("name");
      if (!name) return fail(res, 400, "缺少 name 参数");
      try {
        const r = await M.saveAudioStream(user, name, req);
        audit(user.id, "audio.upload", `${r.name} · ${(r.size / 1048576).toFixed(1)}MB`, ip);
        return ok(res, r);
      } catch(e){ return fail(res, e.code || 500, e.message); }
    }

    if (p === "/api/audio/play" && req.method === "GET"){
      if (!user) return need();
      // 只放自己音频库里的文件：路径只取文件名，不让前端带目录过来探别的盘
      const f = path.basename(String(url.searchParams.get("path") || ""));
      const full = path.join(M.userAudioDir(user.id), f);
      if (!f || !fs.existsSync(full)) return fail(res, 404, "音频不存在");
      return serveFile(req, res, full, { download: false });
    }

    if (p === "/api/audio/delete" && req.method === "POST"){
      if (!user) return need();
      const b = await readJson(req);
      const done = M.deleteAudio(user, b.name);
      if (done) audit(user.id, "audio.delete", String(b.name || ""), ip);
      return ok(res, { deleted: done });
    }

    /* ---------- 选文件夹（给「另存到」用） ---------- */
    if (p === "/api/pickdir" && req.method === "POST"){
      if (!user) return need();
      if (process.platform !== "win32") return fail(res, 400, "只有 Windows 能弹选择框，请直接填路径");
      // 中文路径不能走 stdout 传回来：PowerShell 按控制台代码页（中文系统 936）输出，
      // Node 按 UTF-8 收，汉字全变成 U+FFFD，写盘就会建出「E:\AI????」这种目录。
      // 所以让它把选中的路径写成 UTF-8 文件，Node 再读文件。
      const tmp = path.join(os.tmpdir(), `remix-pick-${Date.now()}-${process.pid}.txt`);
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$f.Description = '选择成片保存位置'",
        "$f.ShowNewFolderButton = $true",
        `$out = '${tmp.replace(/'/g, "''")}'`,
        "if ($f.ShowDialog() -eq 'OK') { [System.IO.File]::WriteAllText($out, $f.SelectedPath, (New-Object System.Text.UTF8Encoding $false)) }"
      ].join("; ");
      // 用户可能在弹窗上发呆，给足两分钟
      const r = await run("powershell", ["-NoProfile", "-STA", "-Command", ps], { timeout: 120000 });
      let dir = "";
      try {
        if (fs.existsSync(tmp)) dir = fs.readFileSync(tmp, "utf8").replace(/^\uFEFF/, "").trim();
      } catch(e){}
      try { fs.unlinkSync(tmp); } catch(e){}
      if (!dir) return fail(res, 400, r.code === 0 ? "没有选择文件夹" : "打开选择框失败：" + String(r.err || "").slice(-160));
      if (dir.includes("\uFFFD")) return fail(res, 500, "选中的路径读出来是乱码，请手动粘贴路径");
      if (!fs.existsSync(dir)) return fail(res, 400, "这个目录打不开：" + dir);
      return ok(res, { dir });
    }

    /* ---------- 参考视频：贴链接抓下来 ---------- */
    if (p === "/api/fetch-link" && req.method === "POST"){
      if (!user) return need();
      const b = await readJson(req).catch(() => ({}));
      const url = String(b.url || "").trim();
      if (!url) return fail(res, 400, "请先贴链接");
      const dir = path.join(DIRS.media, String(user.id), "ref");
      try {
        const r = await fetchVideoLink(url, dir, { onLog: m => audit(user.id, "fetch.link", m, ip) });
        const info = await probe(r.path).catch(() => null);
        if (!info || !info.hasVideo){
          try { fs.unlinkSync(r.path); } catch(e){}
          return fail(res, 502, "抓到的文件不是能用的视频，换一个链接试试");
        }
        audit(user.id, "fetch.link.ok", `${r.name} · ${url.slice(0, 80)}`, ip);
        return ok(res, {
          path: r.path, name: r.name, size: r.size, title: r.title,
          duration: +(info.duration || 0).toFixed(2),
          width: info.width, height: info.height
        });
      } catch(e){
        return fail(res, e.code || 500, e.message || "抓取失败");
      }
    }

    /* ---------- 生成 ---------- */
    if (p === "/api/generate" && req.method === "POST"){
      if (!user) return need();
      const b = await readJson(req);
      const lines = (Array.isArray(b.script) ? b.script : String(b.script || "").split("\n"))
        .map(s => String(s).trim()).filter(Boolean);
      if (!lines.length) return fail(res, 400, "文案为空");
      const { good, bad } = M.checkBatch(user, b.files || []);
      if (!good.length){
        return fail(res, 400, bad.length ? "所选素材无权访问或不存在" : "至少要选一段素材");
      }
      // 参考素材四栏：本机路径，音频（mp3/wav）也要放行。
      // 校验只挡「别人上传目录」的越权（403）；路径不存在 / 格式不对时透传原值，
      // 让渲染日志明确写出「参考视频未生效：路径不存在」，而不是静默丢字段。
      const refPath = s => {
        const v = String(s || "").trim();
        if (!v) return "";
        const r = M.resolveMediaPath(user, v, { allowAudio: true });
        return (!r.ok && r.code === 403) ? "" : v;
      };
      // 另存位置：只接受本机绝对路径。含 U+FFFD 说明前端拿到的是乱码（历史上
      // PowerShell 回传中文路径踩过），这时候宁可报错，也不能去建一个假目录。
      const outRaw = String(b.outDir || "").trim();
      if (outRaw.includes("\uFFFD")){
        return fail(res, 400, "保存位置里有乱码字符，请点「选择」重新挑一次，或手动粘贴路径");
      }
      const outDir = (() => {
        if (!outRaw) return "";
        try { return path.isAbsolute(outRaw) ? path.resolve(outRaw) : ""; } catch(e){ return ""; }
      })();
      const cfg = {
        script: lines,
        files: good,
        title: String(b.title || "").slice(0, 60),
        speed: clamp(+b.speed || 1, 0.5, 2),
        gapMs: clamp(+b.gapMs || 160, 0, 1500),
        // 换画面档位：single 严格一句一镜 / std 长句才补刀（默认）/ multi 多切
        shotsMode: ["exact", "single", "std", "multi", "fast", "none"].includes(b.shotsMode) ? b.shotsMode : "exact",
        font: String(b.font || "SimHei").slice(0, 30),
        subSize: clamp(+b.subSize || 62, 36, 96),
        voice: VOICES.some(v => v.id === b.voice) ? b.voice : undefined,
        bgm: refPath(b.bgm),
        disableBgm: b.disableBgm === true,
        bgmVol: clamp(+b.bgmVol || 0.14, 0, 1),
        refVideo: refPath(b.refVideo),
        // 用户自己配音的成品音频：整条当人声，网站只负责按它铺字幕、卡镜头
        voFile: refPath(b.voFile),
        refVO: refPath(b.refVO),
        refCover: refPath(b.refCover),
        useRefAudio: !!b.useRefAudio,
        // 本机克隆音色：填了 key 就走服务端 F5 / GPT-SoVITS，不连 WorkBuddy
        cloneVoice: findCloneVoice(b.cloneVoice) ? String(b.cloneVoice).trim() : "",
        // 网页云端音色：填了就走 cloud-tts.mjs（火山豆包 2.0 / 免费 edge），不装本机权重
        cloudVoice: findCloudVoice(b.cloudVoice) ? String(b.cloudVoice).trim() : "",
        // 另存位置：已在上面校验过（绝对路径 + 无乱码）
        outDir,
        // 字幕特效（开场呐喊 + 声波 + 关键词划重点）与点睛音效：默认开，明确传 false 才关
        subFx: b.subFx !== false,
        sfx: b.sfx !== false,
        // 参考视频的 BGM：默认「分离出纯伴奏再用」，传 false 则退回整条原声压低当背景
        useRefBgm: b.useRefBgm !== false,
        // 内置默认声音（包里自带的参考音轨 + 字幕）：不传就当开着，明确传 false 才走自配音
        useDefaultAudio: b.useDefaultAudio !== false
      };
      const id = J.createJob(user, cfg, "web");
      audit(user.id, "job.create", `${id} · ${lines.length}句 · ${good.length}素材`, ip);
      return ok(res, { id });
    }

    if (/^\/api\/job\/[^/]+$/.test(p) && (req.method === "GET" || req.method === "DELETE")){
      if (!user) return need();
      const id = p.split("/")[3];
      if (req.method === "DELETE"){
        if (!J.deleteJob(id, user)) return fail(res, 404, "任务不存在");
        audit(user.id, "job.delete", id, ip);
        return ok(res, { deleted: true });
      }
      const j = J.getJob(id, user);
      if (!j) return fail(res, 404, "任务不存在");
      return sendJson(res, 200, j);
    }

    /* ---------- 历史 ---------- */
    if (p === "/api/jobs" && req.method === "GET"){
      if (!user) return need();
      return ok(res, { jobs: J.listJobs(user, Number(url.searchParams.get("limit") || 20)) });
    }

    /* ---------- 成片文件 ---------- */
    if (p.startsWith("/api/file/") && req.method === "GET"){
      const [, , , id, name] = p.split("/");
      const u = user || await tokenFromQuery(url);
      if (!u) return need();
      const j = J.getJob(id, u);
      if (!j) return fail(res, 404, "任务不存在");
      const allow = { "video.mp4": j.video, "cover.jpg": j.cover, "subtitle.srt": j.srt };
      if (!(name in allow) || !allow[name]) return fail(res, 404, "文件不存在");
      const base = j.deliver?.dir || j.runDir;
      const file = path.join(base, name);
      if (!fs.existsSync(file)) return fail(res, 404, "文件已清理");
      return serveFile(req, res, file, { download: url.searchParams.get("dl") === "1" });
    }

    /* ---------- 打开成片所在文件夹 ---------- */
    /**
     * 服务就跑在同事自己电脑上，所以能直接唤出资源管理器。
     * 只打开「你自己的某个任务」的成片目录，路径不从前端拿，避免被拿来探目录。
     */
    if (p.startsWith("/api/reveal/") && req.method === "POST"){
      if (!user) return need();
      const id = p.split("/")[3];
      const j = J.getJob(id, user);
      if (!j) return fail(res, 404, "任务不存在");
      // 用户指定过「另存到」就优先开那儿；没指定或已删除再退回成片库
      const saved = j.meta?.savedTo && fs.existsSync(j.meta.savedTo) ? j.meta.savedTo : null;
      const dir = saved || j.deliver?.dir || j.runDir;
      if (!dir || !fs.existsSync(dir)) return fail(res, 404, "成片目录已清理");
      try {
        const cmd = process.platform === "win32" ? "explorer.exe"
          : process.platform === "darwin" ? "open" : "xdg-open";
        spawn(cmd, [dir], { detached: true, stdio: "ignore" }).unref();
      } catch(e){
        return fail(res, 500, "打不开文件夹：" + e.message);
      }
      return ok(res, { dir });
    }

    /* ---------- 个人 Token ---------- */
    // 本机没有令牌库：转给中央签发，用当前会话的票据认人
    if (isLocal && p.startsWith("/api/tokens")){
      if (!user) return need();
      return proxyToCentral(req, res, p);
    }

    if (p.startsWith("/api/tokens") && !CAN_MANAGE)
      return fail(res, 404, "令牌请到公司账号服务页面生成");

    if (p === "/api/tokens" && req.method === "GET"){
      const owner = user || bearerSessionUser(req);
      if (!owner) return need();
      return ok(res, { tokens: A.listTokens(owner.id) });
    }

    if (p === "/api/tokens" && req.method === "POST"){
      // 网页 cookie 或本机代理带过来的会话票据，两者都算「本人登录着」
      const owner = user || bearerSessionUser(req);
      if (!owner) return need();
      const b = await readJson(req);
      const n = q.get("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL", owner.id).n;
      if (n >= 20) return fail(res, 400, "最多 20 个有效 Token，请先撤销不用的");
      const t = A.issueToken(owner.id, b.name);
      audit(owner.id, "token.issue", b.name || "WorkBuddy", ip);
      return ok(res, { token: t.token, expires_at: t.expires_at, note: "Token 只显示这一次，请立即保存" });
    }

    if (p.startsWith("/api/tokens/") && req.method === "DELETE"){
      const owner = user || bearerSessionUser(req);
      if (!owner) return need();
      const id = Number(p.split("/").pop());
      const done = A.revokeToken(owner.id, id);
      if (done) audit(owner.id, "token.revoke", "id=" + id, ip);
      return done ? ok(res, {}) : fail(res, 404, "Token 不存在");
    }

    /* ---------- 账号管理 ---------- */
    // 没有管理员这一说：登录进来的人都能看账号、建账号、停用、删除。
    // 团队内部几台机器自己用，不需要分角色，也就不该有人因为「权限不足」卡住。
    if (p.startsWith("/api/admin/")){
      if (!CAN_MANAGE) return fail(res, 404, "账号管理请到公司账号服务页面进行");
      if (!user) return need();

      if (p === "/api/admin/users" && req.method === "GET"){
        // jobs/assets 是本机自己的（单机版才有数）；rep_* 是员工电脑回传上来的。
        // 中央不存作品，所以只能靠 rep_*，前端取两者中大的那个显示。
        const rows = q.all(`SELECT u.id, u.username, u.role, u.disabled, u.created_at,
            (SELECT COUNT(*) FROM assets WHERE user_id = u.id) AS assets,
            (SELECT COUNT(*) FROM jobs WHERE user_id = u.id) AS jobs,
            (SELECT COUNT(*) FROM api_tokens WHERE user_id = u.id AND revoked_at IS NULL) AS tokens,
            (SELECT MAX(created_at) FROM sessions WHERE user_id = u.id) AS last_login,
            (SELECT COALESCE(SUM(x.jobs), 0) FROM usage x WHERE x.ext_uuid = u.uuid) AS rep_jobs,
            (SELECT COALESCE(SUM(x.done), 0) FROM usage x WHERE x.ext_uuid = u.uuid) AS rep_done,
            (SELECT MAX(x.updated_at) FROM usage x WHERE x.ext_uuid = u.uuid) AS rep_at,
            (SELECT COUNT(DISTINCT x.machine) FROM usage x WHERE x.ext_uuid = u.uuid) AS machines
          FROM users u ORDER BY u.id`);
        return ok(res, { users: rows });
      }

      // 自助注册开关：员工注册完就关掉，避免外部人乱建号
      if (p === "/api/admin/register" && req.method === "POST"){
        const b = await readJson(req);
        const open = !!b.open;
        if (process.env.REMIX_ALLOW_REGISTER === "0" && open)
          return fail(res, 400, "环境变量已强制关闭注册，改不了");
        q.run(`INSERT INTO settings (key, value, updated_at) VALUES ('register_open', ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          open ? "1" : "0", now());
        audit(user.id, open ? "admin.register.open" : "admin.register.close", null, ip);
        return ok(res, { registerOpen: registerOpen() });
      }

      /**
       * 删除账号（真删，不是停用）。
       *
       * 没有角色之分，所以只剩一条硬护栏：不能删自己 —— 删完就没人能进设置了。
       * 其余交给确认框说清楚（连令牌一起消失，不能撤销）。
       */
      if (/^\/api\/admin\/users\/\d+$/.test(p) && req.method === "DELETE"){
        const id = Number(p.split("/")[4]);
        const target = q.get("SELECT * FROM users WHERE id = ?", id);
        if (!target) return fail(res, 404, "用户不存在");
        if (id === user.id) return fail(res, 400, "不能删除自己");

        // 先清挂在这个身份上的东西，再删人，避免留下无效会话和令牌
        q.run("DELETE FROM sessions WHERE user_id = ?", id);
        q.run("DELETE FROM api_tokens WHERE user_id = ?", id);
        if (target.uuid) q.run("DELETE FROM usage WHERE ext_uuid = ?", target.uuid);
        q.run("DELETE FROM users WHERE id = ?", id);

        audit(user.id, "admin.delete", target.username, ip);
        return ok(res, { id, username: target.username, deleted: true });
      }

      if (/^\/api\/admin\/users\/\d+\/(disable|enable)$/.test(p) && req.method === "POST"){
        const [, , , , id, act] = p.split("/");
        const target = q.get("SELECT * FROM users WHERE id = ?", Number(id));
        if (!target) return fail(res, 404, "用户不存在");
        if (Number(id) === user.id && act === "disable")
          return fail(res, 400, "不能停用自己");
        q.run("UPDATE users SET disabled = ? WHERE id = ?", act === "disable" ? 1 : 0, Number(id));
        if (act === "disable") q.run("DELETE FROM sessions WHERE user_id = ?", Number(id));
        audit(user.id, "admin." + act, target.username, ip);
        return ok(res, { id: Number(id), disabled: act === "disable" });
      }

      if (/^\/api\/admin\/users\/\d+\/password$/.test(p) && req.method === "POST"){
        const id = Number(p.split("/")[4]);
        const target = q.get("SELECT * FROM users WHERE id = ?", id);
        if (!target) return fail(res, 404, "用户不存在");
        const tmp = "Tmp" + Math.random().toString(36).slice(2, 8) + "9a";
        q.run("UPDATE users SET pass_hash = ? WHERE id = ?", A.hashPassword(tmp), id);
        q.run("DELETE FROM sessions WHERE user_id = ?", id);
        audit(user.id, "admin.reset", target.username, ip);
        return ok(res, { username: target.username, password: tmp, note: "请立即告知用户并让其自行修改" });
      }

      if (p === "/api/admin/audit" && req.method === "GET"){
        return ok(res, { rows: q.all("SELECT * FROM audit ORDER BY id DESC LIMIT 200") });
      }

      if (p === "/api/admin/stats" && req.method === "GET"){
        const tts = await detectEngine();
        return ok(res, {
          users: q.get("SELECT COUNT(*) AS n FROM users").n,
          jobs: q.get("SELECT COUNT(*) AS n FROM jobs").n,
          done: q.get("SELECT COUNT(*) AS n FROM jobs WHERE status='done'").n,
          failed: q.get("SELECT COUNT(*) AS n FROM jobs WHERE status='error'").n,
          assets: q.get("SELECT COUNT(*) AS n FROM assets").n,
          tokens: q.get("SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL").n,
          // 员工电脑回传上来的总量（中央自己不渲染）
          reportedJobs: q.get("SELECT COALESCE(SUM(jobs),0) AS n FROM usage").n,
          reportedDone: q.get("SELECT COALESCE(SUM(done),0) AS n FROM usage").n,
          machines: q.get("SELECT COUNT(DISTINCT machine) AS n FROM usage").n,
          registerOpen: registerOpen(),
          tts
        });
      }
    }

    /* ---------- 其余 ---------- */
    return fail(res, 404, "接口不存在");
  } catch(e){
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error("[http]", req.method, req.url, e);
    return fail(res, code, e.message || "服务端错误");
  }
}

/* ---------------- 辅助 ---------------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

async function tokenFromQuery(url){
  const t = url.searchParams.get("t");
  if (!t) return null;
  return A.userFromBearer({ headers: { authorization: "Bearer " + t } });
}

function sessionExpiry(token){
  const r = q.get("SELECT expires_at FROM sessions WHERE token_hash = ?", A.sha256(token));
  return r ? Math.max(0, r.expires_at - now()) : null;
}

export function serveFile(req, res, file, opt = {}){
  let st;
  try { st = fs.statSync(file); } catch(e){ return sendText(res, 404, "文件不存在"); }
  if (!st.isFile()) return sendText(res, 404, "文件不存在");

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const range = req.headers.range;

  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": ext === ".html" ? "no-cache" : "private, max-age=60"
  };
  if (opt.download){
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  }

  if (range){
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m){
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start >= st.size){ 
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Content-Length": end - start + 1
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, { ...headers, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}
