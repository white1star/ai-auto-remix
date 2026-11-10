/**
 * 作品数回传 —— 只回数字，不回内容。
 *
 * 渲染在员工各自电脑上，作品和素材都不上传中央，所以中央的 /admin 看不到
 * 「谁做了几条」。这里补的是一条极轻的上报：本机算好自己的计数，
 * 用中央签发的 report 票据调一次 POST /api/report/usage，报完就完。
 *
 * 明确不做的事：
 *   - 不传标题、不传文案、不传文件、不传素材数量之外的任何信息
 *   - 不实时推送，只在任务落库后防抖 2 秒报一次
 *   - 上报失败不重试、不打扰用户，下一次任务完成时会再报（覆盖式，不会丢数）
 */
import os from "node:os";
import { q, now } from "./db.mjs";
import { CENTRAL_URL, isLocal } from "./role.mjs";

/** 机器标识：同一台电脑重装后宿主名不变，计数会覆盖到同一行，不会翻倍 */
const MACHINE = (os.hostname() || "unknown").slice(0, 64);

/** 本机某个账号的当前计数 */
export function localCounts(localUserId){
  return {
    jobs: q.get("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?", localUserId).n,
    done: q.get("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status = 'done'", localUserId).n,
    assets: q.get("SELECT COUNT(*) AS n FROM assets WHERE user_id = ?", localUserId).n
  };
}

let timer = null;
let running = false;

/**
 * 防抖上报。连着出三条片子只会打一次网络，不会把中央当监控打。
 * 只有 local 角色需要：单机版自己就是全部，中央版没有本机作品。
 */
export function reportUsageSoon(delay = 2000){
  if (!isLocal || !CENTRAL_URL) return;
  if (timer) return;
  timer = setTimeout(() => { timer = null; reportUsage().catch(() => {}); }, delay);
  if (timer.unref) timer.unref();
}

export async function reportUsage(){
  if (!isLocal || !CENTRAL_URL) return { skipped: true };
  if (running) return { busy: true };
  running = true;
  try {
    const users = q.all(
      "SELECT id, ext_uuid, username, report_ticket FROM users WHERE report_ticket IS NOT NULL AND report_ticket <> '' AND ext_uuid IS NOT NULL"
    );

    const sent = [];
    for (const u of users){
      const c = localCounts(u.id);
      try {
        const r = await fetch(new URL("/api/report/usage", CENTRAL_URL), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + u.report_ticket },
          body: JSON.stringify({ machine: MACHINE, username: u.username, ...c }),
          signal: AbortSignal.timeout(8000)
        });
        sent.push({ username: u.username, ok: r.ok, status: r.status });
        // 票据被中央拒（账号停用/过期）就清掉，免得每次任务完成都白打一次
        if (r.status === 401) q.run("UPDATE users SET report_ticket = NULL WHERE id = ?", u.id);
      } catch(e){
        sent.push({ username: u.username, ok: false, error: e.message });
      }
    }
    return { at: now(), machine: MACHINE, sent };
  } finally {
    running = false;
  }
}
