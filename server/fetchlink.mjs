/**
 * 链接 → 本机视频文件。
 *
 * 网页上给一个「参考视频」输入框，用户把抖音/快手/B站的分享链接贴进去，
 * 这里调技能里的 dl-link.mjs（无头浏览器从网络层截真实播放地址，专治抖音反爬），
 * 把片子落到用户素材目录的 ref/ 下，再交给渲染链去分离 BGM。
 *
 * 为什么复用技能脚本：那套 CDP 逻辑已经在声音克隆那边跑通过，
 * 同一件事维护两份必然分叉。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "connector", "skills", "voice-clone-dub", "scripts", "dl-link.mjs");

/** CDP 固定端口，抓取必须串行，否则两个无头浏览器会抢同一个调试端口 */
let chain = Promise.resolve();

function runNode(args, timeout = 180000){
  return new Promise(resolve => {
    let out = "", err = "";
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    } catch(e){
      return resolve({ code: -1, out, err: String(e.message) });
    }
    const kill = setTimeout(() => { try { child.kill(); } catch(e){} }, timeout);
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    child.on("error", e => { clearTimeout(kill); resolve({ code: -1, out, err: String(e.message) }); });
    child.on("close", code => { clearTimeout(kill); resolve({ code, out, err }); });
  });
}

/**
 * @param {string} url    分享链接（http/https）
 * @param {string} outDir 落盘目录
 * @param {object} opt    {onLog}
 * @returns {Promise<{path:string,name:string,size:number,title:string,note:string}>}
 */
export async function fetchVideoLink(url, outDir, opt = {}){
  const log = typeof opt.onLog === "function" ? opt.onLog : () => {};
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) throw Object.assign(new Error("请贴完整链接（http 或 https 开头）"), { code: 400 });

  fs.mkdirSync(outDir, { recursive: true });
  const name = `ref-${Date.now().toString(36)}.mp4`;
  const dest = path.join(outDir, name);

  const job = chain.then(async () => {
    log(`正在打开链接抓视频：${u.slice(0, 80)}`);
    const r = await runNode([SCRIPT, u, outDir, name]);
    const msg = (r.err || "").trim().split("\n").filter(Boolean);
    const title = (msg.find(l => l.startsWith("标题:")) || "").replace(/^标题:\s*/, "");
    if (r.code !== 0 || !fs.existsSync(dest)){
      const why = msg.filter(l => !l.startsWith("标题:")).slice(-2).join(" | ");
      throw Object.assign(new Error(why || `抓取失败（退出码 ${r.code}）`), { code: 502 });
    }
    const size = fs.statSync(dest).size;
    if (size < 30 * 1024){
      try { fs.unlinkSync(dest); } catch(e){}
      throw Object.assign(new Error("抓到的文件太小，可能是分片或防盗链，换一个链接再试"), { code: 502 });
    }
    return { path: dest, name, size, title: title.slice(0, 60), note: "已抓取，BGM 会从这条片子里分离" };
  });

  // 队列不能因为一次失败就断掉
  chain = job.catch(() => {});
  return job;
}
