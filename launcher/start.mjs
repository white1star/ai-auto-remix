/**
 * 员工版启动器 —— 双击「启动.bat」后由它接管。
 *
 * 依次做四件事：
 *   1. 找到运行时（本机自带的优先，其次系统 PATH），缺什么就明说缺什么
 *   2. 定数据目录、定端口，判断是不是已经在跑（重复双击只打开浏览器）
 *   3. 起服务
 *   4. 等接口通了再打开浏览器，避免白屏
 *
 * 参数：
 *   --check       只体检不启动，排障用
 *   --no-browser  启动但不自动开浏览器
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");              // 含 server/ 与 index.html 的那一层
const RUNTIME = path.join(ROOT, "runtime");
const ARGS = new Set(process.argv.slice(2));
const CHECK_ONLY = ARGS.has("--check");
const NO_BROWSER = ARGS.has("--no-browser");

const log = s => console.log(s);
const blank = () => log("");
const hr = () => log("─".repeat(58));

/* ---------------- 配置 ---------------- */
function readConfig(){
  const cands = [
    path.join(ROOT, "配置.json"),
    path.join(HERE, "config.json"),
    path.join(ROOT, "config.json")
  ];
  for (const f of cands){
    if (!fs.existsSync(f)) continue;
    try {
      const raw = fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");
      return { ...JSON.parse(raw), __file: f };
    } catch(e){
      fatal(`配置文件读不出来：${f}\n  ${e.message}`);
    }
  }
  return {};
}

function fatal(msg){
  blank(); hr();
  log("  启动失败");
  log("");
  for (const line of String(msg).split("\n")) log("  " + line);
  hr(); blank();
  process.exit(1);      // 由 启动.bat 负责 pause，别在这里抢键盘
}

/* ---------------- 运行时定位 ---------------- */
const EXE = process.platform === "win32" ? ".exe" : "";

/** 本机自带的优先，没有再交给系统 PATH */
function resolveBin(name, runtimeSub, probeArgs){
  const bundled = path.join(RUNTIME, runtimeSub);
  if (fs.existsSync(bundled)) return bundled;
  const r = spawnSync(name, probeArgs, { windowsHide: true, timeout: 8000 });
  if (!r.error && r.status === 0) return name;
  return null;
}

function checkRuntime(){
  const bins = {
    ffmpeg: resolveBin("ffmpeg", "ffmpeg" + EXE, ["-version"]),
    ffprobe: resolveBin("ffprobe", "ffprobe" + EXE, ["-version"]),
    edgeTts: resolveBin("edge-tts", path.join("edge-tts", "edge-tts" + EXE), ["--version"])
  };
  return bins;
}

/* ---------------- 端口 ---------------- */
function portFree(port){
  return new Promise(resolve => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

function httpJson(url, timeout = 2500){
  return new Promise(resolve => {
    const req = http.get(url, { timeout }, res => {
      let b = "";
      res.on("data", d => b += d);
      res.on("end", () => {
        try { resolve(JSON.parse(b)); } catch(e){ resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

/** 端口上跑的是不是我们自己 */
async function probeSelf(port){
  const cfg = await httpJson(`http://127.0.0.1:${port}/api/auth/config`);
  return cfg && cfg.ok && (cfg.role === "local" || cfg.role === "standalone")
    ? cfg : null;
}

function openBrowser(url){
  if (process.platform === "win32")
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else if (process.platform === "darwin")
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function waitReady(port, ms = 25000){
  const end = Date.now() + ms;
  while (Date.now() < end){
    const cfg = await probeSelf(port);
    if (cfg) return cfg;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

/* ---------------- 主流程 ---------------- */
const cfg = readConfig();
const PORT_PREF = Number(process.env.PORT || cfg.port || 8765);
/**
 * 角色：配置里没写就按单机跑。
 * 单机（standalone）账号、令牌、渲染全在这一台电脑上，设置里就能管账号；
 * 只有明明配了 central 地址、要接公司账号服务时，才走 local。
 */
const ROLE = String(process.env.REMIX_ROLE || cfg.role || (cfg.central ? "local" : "standalone")).toLowerCase();
const NEED_CENTRAL = ROLE === "local";
const CENTRAL = String(process.env.REMIX_CENTRAL || cfg.central || "").replace(/\/+$/, "");

blank();
hr();
log("  AI 自动混剪 · " + (ROLE === "local" ? "员工版" : "单机版"));
hr();
blank();

/* 1. 运行时体检 */
const bins = checkRuntime();
const missing = [];
if (!bins.ffmpeg) missing.push("ffmpeg");
if (!bins.ffprobe) missing.push("ffprobe");

if (CHECK_ONLY){
  log("  运行时");
  log(`    Node      ${process.version}  (${process.execPath})`);
  log(`    ffmpeg    ${bins.ffmpeg || "缺失"}`);
  log(`    ffprobe   ${bins.ffprobe || "缺失"}`);
  log(`    配音      ${bins.edgeTts || "缺失（成片将只有字幕）"}`);
  blank();
  log("  配音音色");
  const cloudKey = path.join(process.env.USERPROFILE || "", ".workbuddy", "voices", ".cloud-key.json");
  log(`    云端凭证  ${fs.existsSync(cloudKey) ? "已配置（火山豆包 2.0 可用）" : "未配置（网页可用免费 edge 音色）"}`);
  log("    云端音色  火山豆包 2.0（按量计费）／免费备用 edge");
  log("    系统音色  8 个（edge-tts，需联网）");
  log("    本机克隆  网页入口已移除（服务端能力保留给命令行 / MCP）");
  blank();
  log("  配置");
  log(`    角色      ${ROLE === "local" ? "员工版（接公司账号服务）" : "单机版（账号在本机）"}`);
  if (NEED_CENTRAL) log(`    中央地址  ${CENTRAL || "未填写"}`);
  log(`    端口      ${PORT_PREF}`);
  blank();
  log(`  目录`);
  log(`    程序      ${ROOT}`);
  log(`    数据      ${pickDataDir()}`);
  blank();
  hr();
  process.exit(missing.length ? 1 : 0);
}

if (missing.length){
  fatal(
    `缺少 ${missing.join("、")}，本机无法剪辑。\n\n` +
    `请重新运行「安装运行时.bat」，或把 ${missing.join(" / ")} 放到：\n  ${RUNTIME}\n\n` +
    `若公司网络下载受限，可让管理员把 runtime 目录整体拷过来。`
  );
}

/* 2. 数据目录 */
function pickDataDir(){
  if (process.env.REMIX_DATA) return path.resolve(process.env.REMIX_DATA);
  if (cfg.dataDir === "portable") return path.join(ROOT, "data");
  if (cfg.dataDir) return path.resolve(String(cfg.dataDir).replace(/^~/, process.env.USERPROFILE || ""));
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || ROOT, "AppData", "Local");
  return path.join(base, "AiAutoRemix", "data");
}
const DATA = pickDataDir();
fs.mkdirSync(DATA, { recursive: true });

/* 本机克隆音色的网页入口已移除，体检不再检查 F5 权重 / Python 环境。
   服务端 server/clone.mjs 仍保留，供命令行与 MCP 调用。 */

/* 3. 中央地址 + 端口 */
if (NEED_CENTRAL && !CENTRAL){
  fatal(
    "配置里指定了要接公司账号服务，但没有填地址。\n\n" +
    `请用记事本打开 ${path.join(ROOT, "配置.json")}，二选一：\n` +
    `  "central": "http://公司地址:9100"     接中央账号服务\n` +
    `  删掉 central 这一行                     改成本机单机运行（账号在自己电脑上管）\n`
  );
}

let PORT = 0;
if (await portFree(PORT_PREF)){
  PORT = PORT_PREF;
} else {
  // 已经在跑：直接开浏览器，不再起第二个
  const me = await probeSelf(PORT_PREF);
  if (me){
    const url = `http://127.0.0.1:${PORT_PREF}/`;
    log(`  服务已在运行 · ${url}`);
    log("  直接打开浏览器…");
    blank();
    if (!NO_BROWSER) openBrowser(url);
    setTimeout(() => process.exit(0), 900);
    await new Promise(() => {});       // 停在这里，让上面的 setTimeout 生效
  }
  // 端口被别的程序占了，往后找一个空的
  for (let p = PORT_PREF + 1; p <= PORT_PREF + 20; p++){
    if (await portFree(p)){ PORT = p; break; }
  }
  if (!PORT) fatal(`端口 ${PORT_PREF}～${PORT_PREF + 20} 都被占用了，请关闭多余的程序后重试。`);
  log(`  端口 ${PORT_PREF} 被占用，改用 ${PORT}`);
}

/* 4. 起服务 */
process.title = "AI 自动混剪 · " + (ROLE === "local" ? "员工版" : "单机版");
Object.assign(process.env, {
  REMIX_ROLE: ROLE,
  REMIX_CENTRAL: NEED_CENTRAL ? CENTRAL : "",
  REMIX_DATA: DATA,
  PORT: String(PORT),
  // 单机版就是给同事在自己电脑上用，仍然只听本机，不往办公网上暴露
  HOST: process.env.HOST || "127.0.0.1",
  ...(bins.ffmpeg ? { FFMPEG: bins.ffmpeg } : {}),
  ...(bins.ffprobe ? { FFPROBE: bins.ffprobe } : {}),
  ...(bins.edgeTts ? { EDGE_TTS: bins.edgeTts } : {})
});

// 中央先探一下，挂了也要让界面能起来（能看到明确提示，而不是白屏）。单机版没有这一步。
const centralAlive = NEED_CENTRAL && !!(await httpJson(CENTRAL + "/api/auth/pubkey", 4000));
if (NEED_CENTRAL && !centralAlive){
  log("");
  log(`  ⚠ 连不上账号服务：${CENTRAL}`);
  log("    界面可以打开，但登录会失败。请检查网络或联系管理员。");
  log("");
}

// Windows 上动态 import 必须先转成 file:// URL
await import(pathToFileURL(path.join(ROOT, "server", "main.mjs")).href);

// 等服务自己说「好了」——它要等语音引擎检测完才打横幅，直接探测会抢在前面
const ready = await (globalThis.__REMIX_READY__ || waitReady(PORT)).catch(() => null);
if (!ready){
  log("  服务没有在预期时间内就绪，请查看上方日志。");
} else {
  const url = `http://127.0.0.1:${PORT}/`;
  blank();
  log(`  已就绪 · ${url}`);
  log("  这个窗口不要关，关掉就等于退出服务。");
  blank();
  if (!NO_BROWSER) openBrowser(url);
}
