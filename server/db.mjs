/**
 * 数据库层 —— node:sqlite 内置，零第三方依赖。
 * 所有表都带 user_id，业务查询一律按 user_id 过滤。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA = path.resolve(process.env.REMIX_DATA || "data");
export const DIRS = {
  root: DATA,
  db: path.join(DATA, "remix.db"),
  media: path.join(DATA, "media"),      // 素材
  audio: path.join(DATA, "audio"),      // 配音 / BGM 音频库
  runs: path.join(DATA, "runs"),        // 每次任务的中间产物与成片
  deliver: path.join(DATA, "deliver")   // 成片库
};
for (const d of Object.values(DIRS)) if (d !== DIRS.db) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(DIRS.db);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  pass_hash  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'user',
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua         TEXT,
  ticket     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  last_used_at INTEGER,
  jti          TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);

CREATE TABLE IF NOT EXISTS assets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'upload',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id);

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  status     TEXT NOT NULL,
  origin     TEXT NOT NULL DEFAULT 'web',
  cfg        TEXT NOT NULL,
  stages     TEXT NOT NULL,
  log        TEXT NOT NULL,
  meta       TEXT,
  video      TEXT, cover TEXT, srt TEXT, run_dir TEXT, deliver_dir TEXT,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);

-- 运行时开关（自助注册等）。放库里而不是只靠环境变量：
-- 管理员在 /admin 点一下就该生效，不用改配置重启服务。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 员工本机回传的计数（只有数字，没有素材和文案）。
-- 按「机器 + 账号」分行：一个人换电脑或被重装，旧行留着，统计时求和。
CREATE TABLE IF NOT EXISTS usage (
  machine    TEXT NOT NULL,
  ext_uuid   TEXT NOT NULL,
  username   TEXT,
  jobs       INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  assets     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (machine, ext_uuid)
);
`);

/* 旧库补列：local 角色要在 sessions 里存签名票据，api_tokens 要存 jti 用于吊销 */
for (const sql of [
  "ALTER TABLE sessions ADD COLUMN ticket TEXT",
  "ALTER TABLE api_tokens ADD COLUMN jti TEXT",
  // uuid：账号的稳定标识。自增 uid 会因中央重建而被重用，uuid 不会
  "ALTER TABLE users ADD COLUMN uuid TEXT",
  // 本机影子行记住「对应哪个中央服务上的哪个账号」
  "ALTER TABLE users ADD COLUMN origin TEXT",
  "ALTER TABLE users ADD COLUMN ext_uid INTEGER",
  "ALTER TABLE users ADD COLUMN ext_uuid TEXT",
  // 本机替这个账号向中央报「做了多少条」用的长效凭证
  "ALTER TABLE users ADD COLUMN report_ticket TEXT"
]){
  try { db.exec(sql); } catch(e){ /* 列已存在 */ }
}

db.exec("CREATE INDEX IF NOT EXISTS idx_users_ext ON users(origin, ext_uuid)");
db.exec("CREATE INDEX IF NOT EXISTS idx_tokens_jti ON api_tokens(jti)");

/* 老账号补 uuid —— 不补的话升级后老票据会对不上人 */
try {
  const lack = db.prepare("SELECT id FROM users WHERE uuid IS NULL OR uuid = ''").all();
  const upd = db.prepare("UPDATE users SET uuid = ? WHERE id = ?");
  for (const r of lack) upd.run(crypto.randomUUID(), r.id);
} catch(e){ /* 表结构还没就绪时跳过 */ }

export const now = () => Date.now();
export const q = {
  get: (sql, ...a) => db.prepare(sql).get(...a),
  all: (sql, ...a) => db.prepare(sql).all(...a),
  run: (sql, ...a) => db.prepare(sql).run(...a)
};

export function audit(userId, action, detail, ip){
  try {
    q.run("INSERT INTO audit (user_id, action, detail, ip, created_at) VALUES (?,?,?,?,?)",
      userId ?? null, action, detail ? String(detail).slice(0, 500) : null, ip || null, now());
  } catch(e){}
}
