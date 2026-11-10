/**
 * 参考链接 → 本机视频文件。
 * 抖音分享页有反爬（curl 只拿到 JS 挑战页），所以用无头 Chrome 自己加载，
 * 从网络层截出带签名的真实播放地址，再带 Referer 下载。
 *
 * 用法: node dev/dl-link.mjs <url> <输出目录> [输出文件名]
 * 输出: 最后一行打印 mp4 绝对路径
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 本机浏览器：Chrome 优先，没有就用 Edge（同样是 Chromium，CDP 一样能用） */
const CHROME_CANDS = [
  process.env.CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);
const CHROME = CHROME_CANDS.find(p => { try { return fs.existsSync(p); } catch(e){ return false; } });
if (!CHROME){
  console.error("本机没找到 Chrome / Edge，抓不了链接。装一个浏览器，或设置环境变量 CHROME 指向浏览器 exe。");
  process.exit(3);
}
const PORT = Number(process.env.CDP_PORT || 9371);
const URL_IN = process.argv[2];
const OUTDIR = path.resolve(process.argv[3] || ".workbuddy/ref-audio");
const NAME = process.argv[4] || "ref.mp4";

if (!URL_IN) { console.error("缺链接"); process.exit(2); }
fs.mkdirSync(OUTDIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-dl-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--mute-audio", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  "--window-size=1280,900", "about:blank"
], { stdio: "ignore" });

async function pageTarget(){
  for (let i = 0; i < 80; i++){
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === "page");
      if (p) return p;
    } catch(e){}
    await sleep(250);
  }
  throw new Error("Chrome 未就绪");
}

let ws, seq = 0;
const pending = new Map();
const media = [];
let pageTitle = "";

function connect(url){
  return new Promise((res, rej) => {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", e => rej(new Error("WS 失败")), { once: true });
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)){
        const { res: r, rej: j } = pending.get(m.id); pending.delete(m.id);
        m.error ? j(new Error(m.error.message)) : r(m.result);
      } else if (m.method === "Network.requestWillBeSent"){
        const u = m.params.request.url;
        // 抖音的 douyinvod / tos 是原逻辑；后面几条让快手、B站、小红书这类也能抓到
        if (/douyinvod|\/video\/tos\/|mime_type=video|\.mp4(\?|$)|\/play\/|videoplayback|\.m4s(\?|$)/i.test(u) && !media.includes(u)) media.push(u);
      }
    });
  });
}
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async expr => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return r.result?.value;
};

try {
  const t = await pageTarget();
  await connect(t.webSocketDebuggerUrl);
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");
  await send("Network.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  });
  await send("Page.navigate", { url: URL_IN });

  // 等反爬跑完 + 播放器起播
  for (let i = 0; i < 20 && media.length === 0; i++) await sleep(1000);
  pageTitle = await evalJs("document.title") || "";
  if (!media.length){
    // 有的页面不自动播，主动点一下 video
    await evalJs("(()=>{const v=document.querySelector('video');if(v){v.muted=true;v.play&&v.play().catch(()=>{});}return !!v;})()");
    for (let i = 0; i < 10 && media.length === 0; i++) await sleep(1000);
  }
  if (!media.length) throw new Error("没截到播放地址（可能需要登录或该链接不支持）");

  const dest = path.join(OUTDIR, NAME);
  // Referer 跟「页面所在站点」走。CDN 域名五花八门（B站走 PCDN 的 *.mountaintoys.cn），
  // 按媒体域名判断会全部 403，只有按来源站点才对。
  const SITE = (() => { try { return new URL(URL_IN).hostname; } catch(e){ return ""; } })();
  const SITE_REF = /bilibili/.test(SITE) ? "https://www.bilibili.com/"
    : /douyin|iesdouyin/.test(SITE) ? "https://www.douyin.com/"
    : /kuaishou/.test(SITE) ? "https://www.kuaishou.com/"
    : /xiaohongshu/.test(SITE) ? "https://www.xiaohongshu.com/"
    : (SITE ? "https://" + SITE + "/" : "");
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const grab = async (url) => {
    const u = new URL(url);
    const r = await fetch(url, {
      headers: {
        "Referer": SITE_REF || u.origin + "/",
        "Origin": SITE_REF.replace(/\/$/, ""),
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9"
      }
    });
    if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}（${u.hostname}）`);
    return Buffer.from(await r.arrayBuffer());
  };

  console.error(`截到 ${media.length} 个媒体地址`);
  media.slice(0, 6).forEach((m, i) => console.error(`  [${i}] ${m.slice(0, 110)}`));

  // B站/YouTube 这类是 DASH 音视频分离：只下视频轨会没声音（BGM 就分离不出来）。
  // 音频轨道号：30216/30232/30250/30251/30280；其余 .m4s 当视频。
  const isAudio = u => /audio\.m4s|mime_type=audio|\.mp3(\?|$)|\.m4a(\?|$)/i.test(u)
    || /-(30216|30232|30250|30251|30280)\.m4s/i.test(u);
  const isDash  = media.some(u => /\.m4s(\?|$)/i.test(u));
  const aUrl = isDash ? media.find(isAudio) : "";
  const vUrl = isDash ? (media.find(u => !isAudio(u)) || media[0]) : media[0];

  const buf = await grab(vUrl);
  fs.writeFileSync(dest, buf);
  console.error(`标题: ${pageTitle.slice(0, 60)}`);
  console.error(`大小: ${(buf.length / 1048576).toFixed(2)} MB`);

  if (aUrl){
    // 音视频分离的站点：把音频轨也下下来合进去，否则成片没声音
    const aFile = path.join(OUTDIR, "ref-audio-track.m4a");
    fs.writeFileSync(aFile, await grab(aUrl));
    const FF = [process.env.FFMPEG,
      path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(process.platform === "win32" ? 1 : 0)),
        "../../../../runtime/ffmpeg.exe"), "ffmpeg"].filter(Boolean)
      .find(p => { try { return fs.existsSync(p); } catch(e){ return false; } }) || "ffmpeg";
    const muxed = path.join(OUTDIR, NAME.replace(/\.mp4$/i, "") + "-mux.mp4");
    await new Promise((res, rej) => {
      const p = spawn(FF, ["-y", "-hide_banner", "-loglevel", "error", "-i", dest, "-i", aFile,
        "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", muxed], { stdio: "inherit" });
      p.on("exit", c => c === 0 ? res() : rej(new Error("音视频合并失败")));
      p.on("error", rej);
    });
    fs.renameSync(muxed, dest);
    try { fs.unlinkSync(aFile); } catch(e){}
    console.error(`已合并音频轨: ${(fs.statSync(dest).size / 1048576).toFixed(2)} MB`);
  } else if (isDash){
    console.error("注意: 没截到音频轨，这条片子可能没声音");
  }
  console.log(dest);
} catch (e) {
  console.error("出错:", e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch(e){}
  chrome.kill();
}
