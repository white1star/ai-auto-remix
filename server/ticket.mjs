/**
 * 身份票据 —— 中央签发，本机只验签。
 *
 * 中央持有 Ed25519 私钥；员工电脑只分发公钥。
 * 这样本机即使被改代码，也伪造不出别人的身份。
 * 票据 = base64url(payload) + "." + base64url(sig)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DIRS, now } from "./db.mjs";

const KEY_DIR = path.join(DIRS.root, "keys");
const PRIV = path.join(KEY_DIR, "ed25519.key.pem");
const PUB = path.join(KEY_DIR, "ed25519.pub.pem");

/* ---------------- 中央：密钥管理 ---------------- */
export function ensureKeys(){
  fs.mkdirSync(KEY_DIR, { recursive: true });
  if (fs.existsSync(PRIV) && fs.existsSync(PUB)){
    return {
      priv: crypto.createPrivateKey(fs.readFileSync(PRIV, "utf8")),
      pub: fs.readFileSync(PUB, "utf8")
    };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const pubPem = publicKey.export({ type: "spki", format: "pem" });
  fs.writeFileSync(PRIV, privPem, { mode: 0o600 });
  fs.writeFileSync(PUB, pubPem);
  return { priv: privateKey, pub: pubPem };
}

let keyCache = null;
const keys = () => (keyCache ||= ensureKeys());

export const publicKeyPem = () => keys().pub;

/* ---------------- 签发（中央） ---------------- */
/**
 * @param {{uid:number, username:string, role:string, kind:'session'|'token', ttlMs:number, jti?:string}} p
 */
export function signTicket(p){
  const payload = {
    v: 1,
    uid: p.uid,
    // 账号的稳定标识。uid 会因中央重建库而被重用，uuid 不会——
    // 本机靠它认人，否则「重建后的 uid=1」会被当成「重建前的 uid=1」
    uuid: p.uuid || null,
    username: p.username,
    role: p.role || "user",
    kind: p.kind || "session",
    jti: p.jti || crypto.randomBytes(8).toString("hex"),
    iat: now(),
    exp: now() + p.ttlMs
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.sign(null, Buffer.from(body), keys().priv).toString("base64url");
  return { ticket: `${body}.${sig}`, payload };
}

/* ---------------- 验签（本机 / 中央自查） ---------------- */
/**
 * @returns {{ok:true, payload:object} | {ok:false, error:string}}
 */
export function verifyTicket(ticket, pubPem){
  if (typeof ticket !== "string" || !ticket.includes("."))
    return { ok: false, error: "票据格式不正确" };
  const [body, sig] = ticket.split(".");
  if (!body || !sig) return { ok: false, error: "票据格式不正确" };

  let key;
  try { key = crypto.createPublicKey(pubPem); }
  catch(e){ return { ok: false, error: "公钥不可用" }; }

  let good = false;
  try {
    good = crypto.verify(null, Buffer.from(body), key, Buffer.from(sig, "base64url"));
  } catch(e){ good = false; }
  if (!good) return { ok: false, error: "票据签名无效" };

  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch(e){ return { ok: false, error: "票据内容损坏" }; }

  if (!payload.exp || payload.exp < now()) return { ok: false, error: "登录已过期，请重新登录" };
  return { ok: true, payload };
}

/* ---------------- 本机：拉取并缓存公钥 ---------------- */
let fetchCache = { pem: null, at: 0 };

export async function getCentralPubkey(centralUrl, { force = false } = {}){
  // 1. 显式配置优先
  if (process.env.REMIX_CENTRAL_PUBKEY){
    try { return fs.readFileSync(process.env.REMIX_CENTRAL_PUBKEY, "utf8"); } catch(e){}
  }
  // 2. 本地缓存文件（离线也能验签）
  const cached = path.join(KEY_DIR, "central.pub.pem");
  // 3. 网络拉取，10 分钟一次
  if (!force && fetchCache.pem && now() - fetchCache.at < 600000) return fetchCache.pem;

  try {
    const r = await fetch(new URL("/api/auth/pubkey", centralUrl), { signal: AbortSignal.timeout(6000) });
    if (r.ok){
      const j = await r.json();
      if (j.pubkey){
        fs.mkdirSync(KEY_DIR, { recursive: true });
        fs.writeFileSync(cached, j.pubkey);
        fetchCache = { pem: j.pubkey, at: now() };
        return j.pubkey;
      }
    }
  } catch(e){}

  if (fs.existsSync(cached)) return fs.readFileSync(cached, "utf8");
  if (fetchCache.pem) return fetchCache.pem;
  throw new Error("拿不到中央公钥，请检查中央服务地址或网络");
}
