/**
 * 入口。
 *   node server/main.mjs                 启动 HTTP 服务（默认 8765）
 *   node server/main.mjs mcp             以 stdio 方式跑 MCP（需 REMIX_TOKEN）
 *   node server/main.mjs adduser 名字 密码 [admin]
 *   node server/main.mjs token 用户名 [名称]
 *   node server/main.mjs users
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DIRS, q } from "./db.mjs";
import * as A from "./auth.mjs";
import { handler } from "./http.mjs";
import { recoverOnBoot } from "./jobs.mjs";
import { startStdioServer } from "./mcp.mjs";
import { detectEngine } from "./tts.mjs";
import { ROLE, isLocal, isCentral, isStandalone, CENTRAL_URL, assertRoleConfig } from "./role.mjs";
import { publicKeyPem, getCentralPubkey } from "./ticket.mjs";

/** 会渲染的角色才需要恢复中断任务 */
const CAN_RENDER_ROLE = () => isStandalone || isLocal;

const args = process.argv.slice(2);
const cmd = args[0] || "serve";
const PORT = Number(process.env.PORT || 8765);
/** 员工本机只服务自己这台机器的浏览器，默认不监听办公网 */
const HOST = process.env.HOST || (isLocal ? "127.0.0.1" : "0.0.0.0");

/** 账号类子命令只在能管账号的角色下可用 */
function needManageRole(what){
  if (isLocal){
    console.error(`[${what}] 本机（local）角色不持有账号库，请到中央账号服务执行`);
    process.exit(1);
  }
}

if (cmd === "mcp"){
  await startStdioServer();
} else if (cmd === "adduser"){
  needManageRole("adduser");
  const [, username, password, role] = args;
  if (!username || !password){
    console.error("用法：node server/main.mjs adduser <用户名> <密码> [admin]");
    process.exit(1);
  }
  const ue = A.validateUsername(username); if (ue){ console.error(ue); process.exit(1); }
  const pe = A.validatePassword(password); if (pe){ console.error(pe); process.exit(1); }
  if (q.get("SELECT id FROM users WHERE username = ?", username.trim())){ console.error("用户名已存在"); process.exit(1); }
  const id = A.createUser(username, password, role === "admin" ? "admin" : undefined);
  console.log(`已创建用户 ${username.trim()} (id=${id}, role=${role === "admin" ? "admin" : q.get("SELECT role FROM users WHERE id=?", id).role})`);
} else if (cmd === "token"){
  needManageRole("token");
  const [, username, name] = args;
  const u = q.get("SELECT * FROM users WHERE username = ?", String(username || "").trim());
  if (!u){ console.error("用户不存在"); process.exit(1); }
  const t = A.issueToken(u.id, name || "CLI");
  console.log("Token（只显示这一次）：");
  console.log(t.token);
  console.log("有效期至：" + new Date(t.expires_at).toLocaleString("zh-CN"));
} else if (cmd === "users"){
  needManageRole("users");
  const rows = q.all("SELECT id, username, role, disabled, created_at FROM users ORDER BY id");
  if (!rows.length) console.log("还没有任何用户");
  for (const r of rows)
    console.log(`${r.id}\t${r.username}\t${r.role}${r.disabled ? "\t已停用" : ""}\t${new Date(r.created_at).toLocaleString("zh-CN")}`);
} else {
  try { assertRoleConfig(); }
  catch(e){ console.error("[配置] " + e.message); process.exit(1); }

  if (CAN_RENDER_ROLE()) recoverOnBoot();

  const server = http.createServer((req, res) => {
    handler(req, res).catch(e => {
      console.error("[fatal]", e);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "服务端异常" }));
    });
  });

  // 大文件上传 / 长任务：放宽超时
  server.requestTimeout = 0;
  server.headersTimeout = 120000;
  server.keepAliveTimeout = 65000;
  server.timeout = 0;

  /** 启动器（launcher/start.mjs）靠这个信号判断「真就绪」，别在横幅打完之前开浏览器 */
  let markReady;
  globalThis.__REMIX_READY__ = new Promise(r => { markReady = r; });

  /**
   * 本机必须在开门之前拿到中央公钥。
   * 否则存在一段窗口期：登录能成功（只写会话不验签），
   * 但下一个请求因为没公钥验不过票 → 立刻 401「请先登录」。
   */
  let pubState = null;
  if (isLocal){
    try {
      const pem = await getCentralPubkey(CENTRAL_URL, { force: true });
      A.setPubkey(pem);
      pubState = { ok: true };
    } catch(e){
      pubState = { ok: false, err: e.message };
    }
  }

  server.listen(PORT, HOST, async () => {
    const engine = isCentral ? "—" : await detectEngine(true);
    const n = q.get("SELECT COUNT(*) AS n FROM users").n;
    const roleName = { central: "中央账号服务", local: "员工本机（渲染）", standalone: "单机全功能" }[ROLE];

    console.log("─".repeat(56));
    console.log(`  AI 自动混剪 · 服务已启动 · ${roleName}`);
    console.log(`  地址    http://127.0.0.1:${PORT}`);

    if (isLocal){
      if (pubState?.ok) console.log(`  中央    ${CENTRAL_URL}  （公钥已就绪）`);
      else console.log(`  中央    ${CENTRAL_URL}  ⚠ ${pubState?.err || "公钥未取到，登录会失败"}`);
    }
    if (isCentral){
      const pk = publicKeyPem();
      const fp = crypto.createHash("sha256").update(pk).digest("hex").slice(0, 16);
      console.log(`  公钥    指纹 ${fp}…（本机用 /api/auth/pubkey 获取）`);
    }

    console.log(`  数据    ${DIRS.root}`);
    if (isCentral) console.log(`  账号    ${n ? n + " 个" : "无（首个注册者自动成为管理员）"}`);
    else console.log(`  配音    ${engine === "none" ? "不可用（降级为字幕）" : engine} · 网页可选云端音色（火山豆包 2.0）`);
    if (!isCentral) console.log(`  MCP     http://127.0.0.1:${PORT}/mcp`);
    console.log("─".repeat(56));
    markReady({ port: PORT, engine });
  });

  const shutdown = () => {
    console.log("\n正在关闭…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
