/**
 * 管理员（中央）启动器 —— 双击「启动-中央.bat」走这里。
 *
 * 和员工版启动器的区别：
 *   员工版  只服务自己这台机器的浏览器（127.0.0.1），要 ffmpeg，要连中央
 *   中央版  要给全公司员工连（0.0.0.0），不渲染所以不要 ffmpeg，数据落在自己目录
 *
 * 中央这台机器是全校唯一「认识所有人」的地方，data/ 里放着签名私钥，
 * 所以数据目录默认就在程序旁边（portable），方便整目录打包备份。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RUNTIME = path.join(ROOT, "runtime");
const ARGS = new Set(process.argv.slice(2));
const NO_BROWSER = ARGS.has("--no-browser");

const log = s => console.log(s);
const blank = () => console.log("");
const hr = () => console.log("─".repeat(56));

/* ---------------- 配置 ---------------- */
function readConfig(){
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "配置.json"), "utf8")); }
  catch(e){ return {}; }
}
const cfg = readConfig();

const PORT_PREF = Number(process.env.PORT || cfg.port || 9100);
const HOST = process.env.HOST || "0.0.0.0";     // 中央必须对局域网开放

function pickDataDir(){
  if (process.env.REMIX_DATA) return path.resolve(process.env.REMIX_DATA);
  if (!cfg.dataDir || cfg.dataDir === "portable") return path.join(ROOT, "data");
  return path.resolve(String(cfg.dataDir).replace(/^~/, process.env.USERPROFILE || ""));
}
const DATA = pickDataDir();

/* ---------------- 小工具 ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function httpJson(url, ms = 2500){
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return await r.json();
  } catch(e){ return null; }
}

/**
 * 端口能不能用：真去 listen 一下再说。
 * 不要用「连一下看有没有被拒」那种写法——反了会把空闲端口判成占用。
 */
function portFree(port){
  return new Promise(resolve => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

async function probeSelf(port){
  const j = await httpJson(`http://127.0.0.1:${port}/api/auth/config`);
  return j && j.role === "central" ? j : null;
}

function openBrowser(url){
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch(e){}
}

/** 这台机器在局域网里的地址，员工版「配置.json」要填的就是它 */
const VIRTUAL_NIC = /vEthernet|WSL|Hyper-V|VMware|VirtualBox|Loopback|TAP-|Tailscale|ZeroTier|VPN|docker/i;
function lanAddresses(){
  const out = [];
  const seen = new Set();
  for (const [name, list] of Object.entries(os.networkInterfaces())){
    // 虚拟网卡（WSL / Hyper-V / 虚拟机）也有 IPv4，但它们员工连不到，
    // 打印出来只会让人填错地址
    if (VIRTUAL_NIC.test(name)) continue;
    for (const a of list || []){
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;          // 自动私有地址，等于没网
      if (seen.has(a.address)) continue;
      seen.add(a.address);
      out.push({ name, address: a.address });
    }
  }
  return out;
}

/* ---------------- 主流程 ---------------- */
blank(); hr();
log("  AI 自动混剪 · 管理员版（账号服务）");
hr(); blank();

log("  运行时");
log(`    Node      ${process.version}`);
log("");
log("  配置");
log(`    端口      ${PORT_PREF}`);
log(`    监听      ${HOST === "0.0.0.0" ? "0.0.0.0（对局域网开放）" : HOST}`);
log(`    数据      ${DATA}`);
blank();

/* 1. 端口：已经在跑就直接开浏览器 */
let PORT = 0;
if (await portFree(PORT_PREF)){
  PORT = PORT_PREF;
} else {
  const me = await probeSelf(PORT_PREF);
  if (me){
    const url = `http://127.0.0.1:${PORT_PREF}/admin`;
    log(`  账号服务已在运行 · ${url}`);
    log("  直接打开浏览器…");
    blank();
    if (!NO_BROWSER) openBrowser(url);
    setTimeout(() => process.exit(0), 900);
    await new Promise(() => {});
  }
  for (let p = PORT_PREF + 1; p <= PORT_PREF + 20; p++){
    if (await portFree(p)){ PORT = p; break; }
  }
  if (!PORT){
    log(`  端口 ${PORT_PREF}～${PORT_PREF + 20} 都被占用了，请关掉多余程序后重试。`);
    process.exit(1);
  }
  log(`  端口 ${PORT_PREF} 被占用，改用 ${PORT}`);
}

/* 2. 数据目录（里面有签名私钥，丢了所有员工版都认不出人） */
fs.mkdirSync(DATA, { recursive: true });
log("");
log("  提示");
log("    data 目录里存着账号库和签名私钥，请单独备份。");
log("    它一丢，所有员工版都会认不出任何人，只能重新建号。");
blank();

/* 3. 起服务 */
process.title = "AI 自动混剪 · 管理员版";
Object.assign(process.env, {
  REMIX_ROLE: "central",
  REMIX_DATA: DATA,
  PORT: String(PORT),
  HOST
});

await import(pathToFileURL(path.join(ROOT, "server", "main.mjs")).href);

const ready = await (globalThis.__REMIX_READY__ || (async () => {
  for (let i = 0; i < 80; i++){
    const j = await probeSelf(PORT);
    if (j) return j;
    await sleep(300);
  }
  return null;
})()).catch(() => null);

if (!ready){
  log("  服务没有在预期时间内就绪，请查看上方日志。");
} else {
  const local = `http://127.0.0.1:${PORT}/admin`;
  blank();
  log(`  已就绪 · ${local}`);
  log("  这个窗口不要关，关掉就等于关掉全公司的账号服务。");
  blank();
  log("  员工版「配置.json」里要填的地址：");
  const lan = lanAddresses();
  if (!lan.length){
    log("    （没检测到局域网地址，这台机器可能没连网）");
  } else {
    for (const a of lan) log(`    http://${a.address}:${PORT}    ← ${a.name}`);
  }
  blank();
  if (!NO_BROWSER) openBrowser(local);
}
