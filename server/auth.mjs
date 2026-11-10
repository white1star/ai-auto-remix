/**
 * 身份层：密码哈希、会话、个人令牌。
 *
 * standalone —— 密码存本地、会话存本地（原来的一体化行为，不动）
 * central    —— 校验密码、签发 Ed25519 身份票据；不渲染
 * local      —— 不存密码；登录时向中央换取票据，本机只验签
 */
import crypto from "node:crypto";
import { q, now, audit } from "./db.mjs";
import { ROLE, isLocal, isCentral, isStandalone, CENTRAL_URL } from "./role.mjs";
import { signTicket, verifyTicket, getCentralPubkey } from "./ticket.mjs";

export const SESSION_TTL = 12 * 3600 * 1000;
/** 上报凭证有效期：够长，员工三个月不重新登录也能继续报数 */
export const REPORT_TTL = 180 * 24 * 3600 * 1000;
export const TOKEN_TTL   = 90 * 24 * 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1 };

/** 本机认人用的稳定标识：优先 uuid，老票据没有 uuid 才退回 uid */
const idOf = payload => payload.uuid || ("uid:" + payload.uid);

export const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const rnd = n => crypto.randomBytes(n).toString("hex");

/* ---------------- 密码 ---------------- */
export function hashPassword(pw){
  const salt = rnd(16);
  const key = crypto.scryptSync(pw, salt, 32, SCRYPT).toString("hex");
  return `s1$${salt}$${key}`;
}

export function verifyPassword(pw, stored){
  try {
    const [tag, salt, key] = String(stored).split("$");
    if (tag !== "s1" || !salt || !key) return false;
    const calc = crypto.scryptSync(pw, salt, 32, SCRYPT);
    const want = Buffer.from(key, "hex");
    return calc.length === want.length && crypto.timingSafeEqual(calc, want);
  } catch(e){ return false; }
}

/* ---------------- 账号校验 ---------------- */
// 不设格式/长度/复杂度限制，只挡空值与超长（防止脏数据与滥用）
export function validateUsername(u){
  if (typeof u !== "string") return "账号不合法";
  const s = u.trim();
  if (!s) return "请填写账号";
  if (s.length > 64) return "账号最多 64 个字符";
  if (/[\x00-\x1f\x7f]/.test(s)) return "账号含不可见字符";
  return null;
}
export function validatePassword(p){
  if (typeof p !== "string") return "密码不合法";
  if (!p) return "请填写密码";
  if (p.length > 128) return "密码最多 128 位";
  return null;
}

export function createUser(username, password, role){
  const name = username.trim();
  // 不再有「第一个注册的就是管理员」：团队内部人人平等，登录后都能看账号、建账号。
  // role 列留着只是为了兼容旧库和命令行 adduser，服务端不再拿它做任何判断。
  const r = q.run(
    "INSERT INTO users (username, pass_hash, role, created_at, uuid) VALUES (?,?,?,?,?)",
    name, hashPassword(password), role || "user", now(),
    crypto.randomUUID()      // 稳定标识：uid 会因重建库被重用，uuid 不会
  );
  return Number(r.lastInsertRowid);
}

/** local 角色：把票据里的身份落到本地影子表，供素材/任务做外键归属 */
/**
 * 本机影子账号：只为让素材/任务有个本地 user_id 挂靠，身份永远以票据为准。
 *
 * 这里不能拿中央 uid 直接当本机主键 —— 中央库一旦重建（换机、重装、恢复备份），
 * uid 会重新从 1 开始，本机就会把新账号认成旧账号，素材直接串到别人名下。
 * 所以按账号 uuid 认人，本机 id 自己递增，两者彻底解耦。
 *
 * 认人不带「中央地址」：地址是会变的（内网换 IP、加 HTTPS 域名、DHCP 重发），
 * 按地址认人等于一换地址所有人就变成「新账号」，此前的素材和作品在界面里全没了。
 * uuid 是 122 位随机值，跨服务器撞车的概率可以忽略，单靠它就够。
 */
export function upsertLocalUser(payload){
  const origin = CENTRAL_URL || "";
  const extId = idOf(payload);

  // 主键路径：账号 uuid。uid 重用、地址变更都不会认错人
  let row = q.get("SELECT * FROM users WHERE ext_uuid = ?", extId);

  // 老库升级：此前写入的影子行没有 ext_uuid，同名才认领，绝不按 uid 硬接
  if (!row && payload.uid != null){
    const legacy = q.get(
      `SELECT * FROM users WHERE ext_uid = ? AND username = ?
         AND (ext_uuid IS NULL OR ext_uuid = '')`,
      payload.uid, payload.username
    );
    if (legacy){
      q.run("UPDATE users SET ext_uuid = ?, origin = ? WHERE id = ?", extId, origin, legacy.id);
      row = q.get("SELECT * FROM users WHERE id = ?", legacy.id);
    }
  }

  if (row){
    // 地址变了就把 origin 更新成新的，方便排查；身份仍然看 uuid
    if (row.origin !== origin)
      q.run("UPDATE users SET origin = ? WHERE id = ?", origin, row.id);
    if (row.username !== payload.username || row.role !== payload.role)
      q.run("UPDATE users SET username = ?, role = ? WHERE id = ?",
        payload.username, payload.role || "user", row.id);
    return { ...row, username: payload.username, role: payload.role || row.role };
  }

  // 本机 username 是 UNIQUE；中央重建后可能出现同名的新账号，加后缀避开冲突
  // （显示用的是票据里的名字，这里存什么不影响界面）
  let name = payload.username, n = 1;
  while (q.get("SELECT id FROM users WHERE username = ?", name))
    name = `${payload.username}~${n++}`;

  q.run(`INSERT INTO users (username, pass_hash, role, disabled, created_at, origin, ext_uid, ext_uuid)
         VALUES (?,?,?,0,?,?,?,?)`,
    name, "", payload.role || "user", now(), origin, payload.uid, extId);
  return q.get("SELECT * FROM users WHERE origin = ? AND ext_uuid = ?", origin, extId);
}

/* ---------------- 登录限流（内存） ---------------- */
const attempts = new Map();
function tooMany(key){
  const rec = attempts.get(key);
  if (!rec) return false;
  if (now() > rec.until){ attempts.delete(key); return false; }
  return rec.count >= 8;
}
function noteFail(key){
  const rec = attempts.get(key) || { count: 0, until: now() + 10 * 60 * 1000 };
  rec.count++; rec.until = now() + 10 * 60 * 1000;
  attempts.set(key, rec);
}

export const publicUser = u => u && ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at });

/* ---------------- 登录（standalone / central） ---------------- */
export function login(username, password, ip, ua){
  const key = `${ip}|${username}`;
  if (tooMany(key)) return { error: "尝试过于频繁，请 10 分钟后再试" };

  const user = q.get("SELECT * FROM users WHERE username = ?", String(username || "").trim());
  if (!user || !verifyPassword(password || "", user.pass_hash)){
    noteFail(key);
    audit(user ? user.id : null, "login.fail", username, ip);
    return { error: "用户不存在或密码错误" };
  }
  if (user.disabled) return { error: "账号已被停用，请联系管理员" };

  attempts.delete(key);
  const token = rnd(32);
  q.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)",
    sha256(token), user.id, now(), now() + SESSION_TTL, (ua || "").slice(0, 200));

  // 中央同时签两张票据：
  //   session —— 12 小时，供本机认人
  //   report  —— 180 天，供本机后台报「这个账号做了多少条」，不需要用户一直挂着会话
  const signed = isCentral
    ? signTicket({ uid: user.id, uuid: user.uuid, username: user.username, role: user.role, kind: "session", ttlMs: SESSION_TTL })
    : null;
  const report = isCentral
    ? signTicket({ uid: user.id, uuid: user.uuid, username: user.username, role: user.role, kind: "report", ttlMs: REPORT_TTL })
    : null;

  audit(user.id, "login.ok", null, ip);
  return {
    token, user: publicUser(user),
    ticket: signed?.ticket || null,
    reportTicket: report?.ticket || null,
    payload: signed?.payload || null
  };
}

/* ---------------- 登录（local：向中央换取票据） ---------------- */
export async function loginViaCentral(username, password, ip, ua){
  const key = `${ip}|${username}`;
  if (tooMany(key)) return { error: "尝试过于频繁，请 10 分钟后再试" };

  let j;
  try {
    const r = await fetch(new URL("/api/auth/login", CENTRAL_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000)
    });
    j = await r.json().catch(() => ({}));
    if (!r.ok) {
      noteFail(key);
      return { error: j.error || "登录失败（HTTP " + r.status + "）" };
    }
  } catch(e){
    return { error: "连不上中央账号服务，请检查网络或联系管理员" };
  }

  attempts.delete(key);
  const r = await acceptTicket(j, ip, ua);
  if (r.error) return r;
  audit(r.user.id, "login.ok", "local", ip);
  return r;
}

/**
 * 拿到中央返回的票据之后，本机要做的事都一样：验签 → 写本地会话 → 落影子账号。
 * 登录和注册只差「中央那边是查密码还是建新号」，这里抽出来避免两份逻辑走岔。
 */
async function acceptTicket(j, ip, ua){
  if (!j.ticket) return { error: "中央未返回身份票据，请确认中央版本已升级" };

  const pub = await getCentralPubkey(CENTRAL_URL).catch(() => null);
  const v = pub ? verifyTicket(j.ticket, pub) : { ok: false, error: "拿不到中央公钥" };
  if (!v.ok) return { error: "身份票据校验失败：" + v.error };

  const sid = rnd(32);
  q.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ua, ticket) VALUES (?,?,?,?,?,?)",
    sha256(sid), v.payload.uid, now(), v.payload.exp, (ua || "").slice(0, 200), j.ticket);
  const row = upsertLocalUser(v.payload);

  // 上报凭证单独存：会话票 12 小时就过期，报数不该跟着断
  if (j.reportTicket)
    q.run("UPDATE users SET report_ticket = ? WHERE id = ?", j.reportTicket, row.id);

  return { token: sid, user: publicUser(row), ticket: j.ticket };
}

/**
 * 中央自助注册开关的本地缓存（5 秒）。
 * 放在注册函数之前声明：注册被拒时要能立刻打掉它，避免界面上继续摆着注册页签。
 */
let cfgCache = { at: 0, v: null };

/**
 * 员工在本机自助注册：账号库只在中央，所以必须由中央建号。
 * 中央建完直接连人带票返回，本机不用再登录一次（少一次往返，也不会出现
 * 「注册成功但登录失败」这种半截状态）。
 */
export async function registerViaCentral(username, password, ip, ua){
  const key = `${ip}|${username}`;
  if (tooMany(key)) return { error: "尝试过于频繁，请 10 分钟后再试" };

  let j;
  try {
    const r = await fetch(new URL("/api/auth/register", CENTRAL_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000)
    });
    j = await r.json().catch(() => ({}));
    if (!r.ok){
      noteFail(key);
      // 403 多半是管理员刚关了注册，把配置缓存打掉，下一次打开页面就不会再摆注册页签
      if (r.status === 403) cfgCache = { at: 0, v: null };
      return { error: j.error || "注册失败（HTTP " + r.status + "）", status: r.status };
    }
  } catch(e){
    return { error: "连不上中央账号服务，请检查网络或联系管理员", status: 0 };
  }

  attempts.delete(key);
  const r = await acceptTicket(j, ip, ua);
  if (r.error) return r;
  audit(r.user.id, "user.register", "local", ip);
  return r;
}

/**
 * 中央还开着自助注册吗。本机得问得到——否则界面上摆个注册页签，
 * 点了才告诉员工「管理员已关闭」，体验很差。
 * 带 5 秒缓存：切页签不会每次都打一次网络，管理员改了开关也顶多晚 5 秒生效。
 */
export async function centralConfig({ force = false } = {}){
  const TTL = 5000;
  if (!force && cfgCache.v && now() - cfgCache.at < TTL) return cfgCache.v;
  try {
    const r = await fetch(new URL("/api/auth/config", CENTRAL_URL), { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    cfgCache = { at: now(), v: j };
    return j;
  } catch(e){
    // 中央暂时不可达时沿用上次结果，别让注册页签一闪一闪
    return cfgCache.v || { allowRegister: false, canRegisterHere: false };
  }
}

export function logout(token){
  if (token) q.run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
}

/* ---------------- Cookie ---------------- */
export function readCookie(req, name){
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")){
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const sessionCookie = (token, maxAgeSec) =>
  `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
export const clearCookie = () =>
  "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";

/* ---------------- 解析当前用户 ---------------- */
export async function userFromSession(req){
  const token = readCookie(req, "sid");
  if (!token) return null;
  const row = q.get("SELECT * FROM sessions WHERE token_hash = ?", sha256(token));
  if (!row){ return null; }
  if (row.expires_at < now()){
    q.run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
    return null;
  }

  // local：会话里存的是中央票据，每次重新验签，身份不由本机自说自话
  if (isLocal){
    if (!row.ticket) return null;
    const v = verifyTicket(row.ticket, pubkeyOrNull());
    if (!v.ok){
      q.run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
      return null;
    }
    return upsertLocalUser(v.payload);
  }

  const u = q.get("SELECT * FROM users WHERE id = ?", row.user_id);
  if (!u || u.disabled) return null;
  return u;
}

let PUB_CACHE = null;
/** 启动时由 main 注入；未注入时同步读缓存文件 */
export function setPubkey(pem){ PUB_CACHE = pem; }
export const pubkeyOrNull = () => PUB_CACHE;

export async function userFromBearer(req){
  const h = req.headers.authorization || "";
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  const plain = h.slice(7).trim();
  if (!plain) return null;

  // central / standalone：令牌是随机串，查库
  if (!isLocal){
    if (!plain.startsWith("wbt_")) return null;
    const row = q.get(
      `SELECT t.*, u.username, u.role, u.disabled FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`, sha256(plain));
    if (!row || row.revoked_at) return null;
    if (row.expires_at < now()) return null;
    if (row.disabled) return null;
    q.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", now(), row.id);
    return { id: row.user_id, username: row.username, role: row.role, token_id: row.id, jti: row.jti };
  }

  // local：令牌是中央签的票据，验签即身份；再尽量问一次中央是否已吊销
  const pub = pubkeyOrNull();
  if (!pub) return null;
  const v = verifyTicket(plain, pub);
  if (!v.ok) return null;
  if (v.payload.kind !== "token") return null;
  if (await isRevoked(v.payload.jti)) return null;

  const u = upsertLocalUser(v.payload);
  return { id: u.id, username: u.username, role: u.role, jti: v.payload.jti, via: "ticket" };
}

/* ---------------- 吊销检查（local，带缓存 + 同步等待） ---------------- */
const REVOKE_TTL = 5000;    // 正常缓存 5 秒
const FAIL_TTL   = 30000;   // 连不上中央时，30 秒后再试，避免每个请求都卡 5 秒
const revokedCache = new Map();

async function isRevoked(jti){
  if (!jti) return false;
  const hit = revokedCache.get(jti);
  const ttl = hit?.failed ? FAIL_TTL : REVOKE_TTL;
  if (hit && now() - hit.at < ttl) return !!hit.revoked;

  const fresh = await refreshRevoked(jti);
  if (fresh === null) return !!(hit && hit.revoked);   // 离线：沿用已知状态，靠过期兜底
  return fresh;
}

/** @returns {Promise<boolean|null>} null 表示没问成 */
async function refreshRevoked(jti){
  try {
    const r = await fetch(new URL("/api/auth/token-status?jti=" + encodeURIComponent(jti), CENTRAL_URL), {
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    revokedCache.set(jti, { revoked: !!j.revoked, at: now() });
    return !!j.revoked;
  } catch(e){
    const prev = revokedCache.get(jti);
    revokedCache.set(jti, { revoked: !!(prev && prev.revoked), at: now(), failed: true });
    return null;
  }
}

/** 中央：供本机查询某个票据是否已吊销 */
export function tokenStatus(jti){
  const row = q.get("SELECT * FROM api_tokens WHERE jti = ?", String(jti || ""));
  if (!row) return { found: false, revoked: true };
  return { found: true, revoked: !!row.revoked_at || row.expires_at < now() };
}

/* ---------------- 个人令牌 ---------------- */
export function issueToken(userId, name){
  const user = q.get("SELECT * FROM users WHERE id = ?", userId);
  const ttl = TOKEN_TTL;
  const exp = now() + ttl;

  // central 签票据；standalone 用随机串（老行为）
  const signed = isCentral
    ? signTicket({ uid: userId, uuid: user.uuid, username: user.username, role: user.role, kind: "token", ttlMs: ttl })
    : null;
  const plain = signed ? signed.ticket : "wbt_" + rnd(24);
  const jti = signed ? signed.payload.jti : null;

  q.run(`INSERT INTO api_tokens (user_id, name, prefix, token_hash, created_at, expires_at, jti)
         VALUES (?,?,?,?,?,?,?)`,
    userId, (name || "WorkBuddy").slice(0, 40),
    signed ? plain.slice(0, 16) : plain.slice(0, 12),
    sha256(plain), now(), exp, jti);

  return { token: plain, expires_at: exp, jti };
}

export function listTokens(userId){
  return q.all(`SELECT id, name, prefix, created_at, expires_at, revoked_at, last_used_at, jti
                FROM api_tokens WHERE user_id = ? ORDER BY id DESC`, userId)
    .map(t => ({ ...t, active: !t.revoked_at && t.expires_at > now() }));
}

export function revokeToken(userId, id){
  const t = q.get("SELECT * FROM api_tokens WHERE id = ? AND user_id = ?", Number(id), userId);
  if (!t) return false;
  q.run("UPDATE api_tokens SET revoked_at = ? WHERE id = ?", now(), t.id);
  revokedCache.set(t.jti, { revoked: true, at: now() });
  return true;
}

/** 网页优先用会话，MCP/CLI 用令牌 */
export async function currentUser(req){
  return (await userFromSession(req)) || (await userFromBearer(req));
}

export { ROLE, isLocal, isCentral, isStandalone, CENTRAL_URL };
