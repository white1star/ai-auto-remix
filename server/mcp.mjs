/**
 * MCP Server —— 复用同一套渲染与鉴权，不重复实现剪辑。
 * 工具只做「查自己素材 / 建任务 / 看进度 / 看历史 / 取结果」，没有删除与命令执行能力。
 */
import fs from "node:fs";
import path from "node:path";
import { q, DIRS } from "./db.mjs";
import * as A from "./auth.mjs";
import * as M from "./media.mjs";
import * as J from "./jobs.mjs";
import * as AR from "./audio-requests.mjs";
import { isCentral } from "./role.mjs";
import { readJson, sendJson, probe, sleep } from "./util.mjs";
import { VOICES } from "./tts.mjs";

export const SERVER_INFO = {
  name: "ai-video-remix",
  version: "2.0.0",
  title: "AI 自动混剪"
};

const TOOLS = [
  {
    name: "list_my_assets",
    title: "列出我的素材",
    description: "列出当前登录员工名下可用的视频与图片素材（含时长、大小、路径）。创建视频前可先调它确认有哪些素材。素材来自两处：拖进来上传的，以及界面里填的素材路径。",
    inputSchema: { type: "object", properties: {
      limit: { type: "number", description: "最多返回多少条，默认 50" }
    }, additionalProperties: false }
  },
  {
    name: "create_video",
    title: "创建混剪视频",
    description: "提交一条竖版（1080×1920）自动混剪任务。需给出逐行视频文案；整段配音后按节奏自动分镜（平均 2.0–2.6 秒一镜，短句自动合并），不需要一句一镜。素材不传则默认用该员工全部素材。返回任务 ID，用 get_job_status 查询进度。渲染通常需要 1–5 分钟。",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "视频文案。字符串按换行拆句，或直接传字符串数组。"
        },
        assets: {
          type: "array", items: { type: "string" },
          description: "素材标识。可以传素材 id、文件名、完整文件路径，或直接传素材文件夹路径（如 E:\\\\AI剪辑\\\\混剪，会把这个目录下的视频图片全部收进来）。不传则使用全部已上传素材。"
        },
        title: { type: "string", description: "成片标题，用于生成封面，建议 8–20 字" },
        speed: { type: "number", description: "语速倍率 0.5–2，默认 1" },
        gap_ms: { type: "number", description: "句间停顿毫秒（逐句兜底模式才生效，默认 160）" },
        shots_mode: { type: "string", enum: ["std", "fast", "none"], description: "已废弃：分镜与运镜由节奏规划决定，此参数不再生效" },
        voice: { type: "string", enum: VOICES.map(v => v.id), description: "仅在关掉内置人声、要网站自己念文案时才用；默认走包里那条参考人声" },
        bgm: { type: "string", description: "背景音乐本机路径（mp3/wav/视频，可选）" },
        vo_file: { type: "string", description: "已经配好的配音音频本机路径（mp3/wav/m4a）。传了它网站就不再合成配音，直接拿这条音频当人声，并按它的句间停顿把文案切成字幕。自己配好音的场景用这个（可选）" },
        ref_video: { type: "string", description: "参考视频本机路径：沿用音轨当 BGM、校准配音语速、卡说话点切镜头（可选）" },
        ref_vo: { type: "string", description: "参考配音本机路径：按它的语速与停顿校准（可选，音色不能克隆）" },
        ref_cover: { type: "string", description: "参考封面本机图片/视频路径：直接沿用（可选）" },
        use_ref_audio: { type: "boolean", description: "直接用参考视频完整音轨当配音+BGM，网站不再自己配音（可选）" },
        use_default_audio: { type: "boolean", description: "用包里自带的内置音轨+字幕（默认开）。开着时不念文案；要念文案就传 false（可选）" }
      },
      required: ["script"],
      additionalProperties: false
    }
  },
  {
    name: "get_job_status",
    title: "查询任务进度",
    description: "查询某个任务的状态与八个阶段进度。可传 wait_seconds 让服务端等待一段时间再返回，减少轮询次数。",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "任务 ID" },
        wait_seconds: { type: "number", description: "最长阻塞等待秒数，0–120，默认 0" }
      },
      required: ["job_id"], additionalProperties: false
    }
  },
  {
    name: "list_my_jobs",
    title: "查看历史作品",
    description: "列出当前员工的历史任务，按时间倒序，含状态、时长、镜数、文件大小。",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "默认 20，最多 100" } },
      additionalProperties: false
    }
  },
  {
    name: "get_job_result",
    title: "获取成片结果",
    description: "取任务的成片、封面、字幕的下载链接与本地路径。任务未完成时返回当前进度。",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", description: "任务 ID" } },
      required: ["job_id"], additionalProperties: false
    }
  },
  {
    name: "wait_audio_request", title: "领取网站音频需求",
    description: "领取当前账号在网页提交的配音/BGM需求。网页逐条交接时，必须用复制指令里的 request_id 精确领取。按原文和参考链接处理，完成后用 finish_audio_request 回填，不得以预设音色替代参考声音。",
    inputSchema: {type:"object", properties:{wait_seconds:{type:"number",description:"等待0–45秒"},request_id:{type:"string",description:"网页提示词里的任务号；只领取这条任务"}}, additionalProperties:false}
  },
  {
    name: "finish_audio_request", title: "回填网站音频结果",
    description: "向网站回填已领取任务的真实本机音频文件，或报告错误/进度。两项均勾选时必须同时提供配音和BGM。没有可用音色复刻工具时必须报告错误，不得假装完成。",
    inputSchema: {type:"object",properties:{request_id:{type:"string"},claim_token:{type:"string"},vo_file:{type:"string"},bgm_file:{type:"string"},note:{type:"string"},error:{type:"string"}},required:["request_id","claim_token"],additionalProperties:false}
  }
];

/* ---------------- 工具实现 ---------------- */
/**
 * 素材引用解析。
 *
 * 支持三种写法，都是「服务端自己去读」，不需要先上传：
 *   - 素材 id / 文件名        → 查库里那条上传记录
 *   - 完整文件路径            → 直接读这个文件
 *   - 文件夹路径              → 把这个目录下的视频图片全部收进来
 */
function refToFiles(user, s){
  let isDir = false;
  try { isDir = fs.statSync(path.resolve(s)).isDirectory(); } catch(e){}
  if (isDir){
    const found = M.readMediaDir(user, s);
    if (!found.ok) throw new Error(`素材目录不可用：${s}（${found.error}）`);
    return found.files;
  }
  const r = M.resolveMediaPath(user, s);
  if (!r.ok) throw new Error(`素材不可用：${s}（${r.error}）`);
  return [r.path];
}

function resolveAssets(user, refs){
  const all = M.listAssets(user);
  if (!refs || !refs.length){
    if (all.length) return { list: all.map(a => a.path), picked: all.length };
    throw new Error("没给素材，也没有已上传的素材。请传素材标识、文件路径，或直接传素材文件夹路径");
  }
  const out = [];
  for (const ref of refs){
    const s = String(ref);
    const hit = all.find(a => String(a.id) === s)
             || all.find(a => a.name === s)
             || all.find(a => path.basename(a.path) === s)
             || all.find(a => path.resolve(a.path).toLowerCase() === path.resolve(s).toLowerCase());
    if (hit){ out.push(hit.path); continue; }
    for (const f of refToFiles(user, s)) out.push(f);
  }
  return { list: [...new Set(out)], picked: out.length };
}

async function toolListAssets(user, args){
  const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
  const all = M.listAssets(user).slice(0, limit);
  const items = [];
  for (const a of all){
    const p = await probe(a.path);
    items.push({
      id: a.id, name: a.name, path: a.path,
      kind: p?.hasVideo ? "video" : "image",
      duration: p?.hasVideo ? +p.duration.toFixed(1) : null,
      size_mb: +(a.size / 1048576).toFixed(1)
    });
  }
  return { count: items.length, assets: items };
}

async function toolCreateVideo(user, args, baseUrl){
  let lines;
  if (Array.isArray(args.script)) lines = args.script.map(s => String(s).trim()).filter(Boolean);
  else lines = String(args.script || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) throw new Error("文案为空");
  if (lines.length > 60) throw new Error("文案超过 60 句，请拆分");

  const { list } = resolveAssets(user, args.assets);
  if (!list.length) throw new Error("没有可用素材，请先上传");

  // 参考素材四栏：本机路径，音频也放行；只挡跨账号越权（403），
  // 路径不存在/格式不对时透传，让渲染日志写明原因。
  const refPath = s => {
    const v = String(s || "").trim();
    if (!v) return "";
    const r = M.resolveMediaPath(user, v, { allowAudio: true });
    return (!r.ok && r.code === 403) ? "" : v;
  };

  const cfg = {
    script: lines,
    files: list,
    title: String(args.title || "").trim().slice(0, 60),
    speed: Math.min(2, Math.max(0.5, Number(args.speed) || 1)),
    gapMs: Math.min(1500, Math.max(0, Number(args.gap_ms ?? 160))),
    shotsMode: ["std", "fast", "none"].includes(args.shots_mode) ? args.shots_mode : "std",
    font: "SimHei",
    subSize: 62,
    voice: VOICES.some(v => v.id === args.voice) ? args.voice : undefined,
    bgm: refPath(args.bgm),
    voFile: refPath(args.vo_file),
    bgmVol: 0.14,
    refVideo: refPath(args.ref_video),
    refVO: refPath(args.ref_vo),
    refCover: refPath(args.ref_cover),
    useRefAudio: !!args.use_ref_audio,
    useDefaultAudio: args.use_default_audio !== false
  };
  const id = J.createJob(user, cfg, "mcp");
  return {
    job_id: id,
    status: "running",
    lines: lines.length,
    assets: list.length,
    estimate_seconds: Math.round(lines.length * 8 + 20),
    next: `用 get_job_status 查询进度，job_id=${id}`,
    status_url: `${baseUrl}/api/job/${id}`
  };
}

async function toolJobStatus(user, args){
  const id = String(args.job_id || "").trim();
  if (!id) throw new Error("缺少 job_id");
  const waitMs = Math.min(120, Math.max(0, Number(args.wait_seconds) || 0)) * 1000;
  const deadline = Date.now() + waitMs;

  for (;;){
    const j = J.getJob(id, user);
    if (!j) throw new Error("任务不存在，或不属于当前账号");
    if (j.status !== "running" || Date.now() >= deadline){
      const running = Object.entries(j.stages || {}).find(([, v]) => v === "running");
      const doneCount = Object.values(j.stages || {}).filter(v => v === "ok").length;
      return {
        job_id: j.id, status: j.status, progress: Math.round(doneCount / 8 * 100),
        current_stage: running ? J.STAGE_NAME[running[0]] : null,
        stages: Object.fromEntries(Object.entries(j.stages || {}).map(([k, v]) => [J.STAGE_NAME[k], v])),
        error: j.error || null,
        meta: j.meta || null,
        hint: j.status === "done" ? "已完成，可用 get_job_result 取文件" : (j.status === "error" ? "失败，请据 error 调整后重试" : "渲染中，请稍后再查")
      };
    }
    await sleep(1500);
  }
}

async function toolListJobs(user, args){
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const rows = J.listJobs(user, limit);
  return {
    count: rows.length,
    jobs: rows.map(r => ({
      job_id: r.id, title: r.title, status: r.status,
      duration: r.meta?.dur ?? null, shots: r.meta?.shots ?? null,
      size_mb: r.meta?.size ?? null,
      created: new Date(r.created_at).toISOString(),
      error: r.error || null
    }))
  };
}

async function toolJobResult(user, args, baseUrl){
  const id = String(args.job_id || "").trim();
  const j = J.getJob(id, user);
  if (!j) throw new Error("任务不存在，或不属于当前账号");
  if (j.status !== "done"){
    return { job_id: j.id, status: j.status, error: j.error || null, hint: "尚未完成，请先用 get_job_status 查询" };
  }
  const dir = j.deliver?.dir;
  const files = {};
  if (dir){
    for (const [key, name] of [["video", "video.mp4"], ["cover", "cover.jpg"], ["subtitle", "subtitle.srt"]]){
      const f = path.join(dir, name);
      if (fs.existsSync(f)) files[key] = { path: f, size_mb: +(fs.statSync(f).size / 1048576).toFixed(2) };
    }
  }
  return {
    job_id: j.id, status: "done",
    duration: j.meta?.dur ?? null, shots: j.meta?.shots ?? null,
    resolution: "1080x1920", voice: j.meta?.voice ?? null, tts: j.meta?.tts ?? null,
    warnings: j.meta?.warnings || [],
    files,
    urls: {
      video: j.video ? baseUrl + j.video : null,
      cover: j.cover ? baseUrl + j.cover : null,
      subtitle: j.srt ? baseUrl + j.srt : null
    }
  };
}

const baseOf = req => process.env.REMIX_PUBLIC_URL
  || (req ? `http://${req.headers.host || "127.0.0.1"}` : "http://127.0.0.1:8765");

/* ---------------- JSON-RPC ---------------- */
async function dispatch(method, params, user, req){
  switch (method){
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO, title: "AI 自动混剪（企业版）" },
        instructions: "这是企业内部的 AI 自动混剪服务。网站是主要工作入口。同事在网页填写文案和参考链接；你用 wait_audio_request 领取音频任务，用 finish_audio_request 回填真实配音和BGM。不要替网站改写文案或自行出片。旧视频工具仅在用户明确要求直接出片时使用。所有数据仅限当前账号。"
      };
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      if (!TOOLS.some(t => t.name === name)) throw Object.assign(new Error("未知工具：" + name), { rpcCode: -32602 });
      const base = baseOf(req);
      let data;
      if (name === "wait_audio_request" || name === "finish_audio_request") {
        if (isCentral) throw new Error("音频助手请连接员工本机服务");
        data = name === "wait_audio_request" ? await AR.waitAudioRequest(user, args.wait_seconds, args.request_id)
          : await AR.finishAudioRequest(user, {...args, id: args.request_id});
      }
      else if (name === "list_my_assets") data = await toolListAssets(user, args);
      else if (name === "create_video") data = await toolCreateVideo(user, args, base);
      else if (name === "get_job_status") data = await toolJobStatus(user, args);
      else if (name === "list_my_jobs") data = await toolListJobs(user, args);
      else if (name === "get_job_result") data = await toolJobResult(user, args, base);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
        isError: false
      };
    }
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw Object.assign(new Error("不支持的方法：" + method), { rpcCode: -32601 });
  }
}

/* ---------------- HTTP 传输 ---------------- */
export async function handleMcpHttp(req, res, url){
  if (req.method === "OPTIONS"){
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
    });
    return res.end();
  }

  if (req.method === "GET"){
    // 健康探测，同时告知怎么接
    return sendJson(res, 200, {
      ok: true, server: SERVER_INFO, transport: "streamable-http",
      auth: "Authorization: Bearer wbt_xxx", tools: TOOLS.map(t => t.name)
    });
  }

  const user = await A.userFromBearer(req);
  if (!user){
    return sendJson(res, 401, {
      jsonrpc: "2.0", id: null,
      error: { code: -32001, message: "缺少或无效的 API Token，请在服务网页「设置 → 个人令牌」创建后填入 Authorization: Bearer wbt_xxx" }
    });
  }

  let body;
  try { body = await readJson(req, 4 * 1024 * 1024); }
  catch(e){ return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "请求体不是合法 JSON" } }); }

  const isBatch = Array.isArray(body);
  const msgs = isBatch ? body : [body];
  const out = [];

  for (const msg of msgs){
    const id = msg?.id ?? null;
    const method = msg?.method;
    if (!method) continue;
    try {
      const result = await dispatch(method, msg.params, user, req);
      if (id === null && method.startsWith("notifications/")) continue;
      if (result === null && method.startsWith("notifications/")) continue;
      out.push({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch(e){
      out.push({ jsonrpc: "2.0", id, error: { code: e.rpcCode || -32603, message: String(e.message || e) } });
    }
  }

  if (!out.length) return sendJson(res, 202, {});
  return sendJson(res, 200, isBatch ? out : out[0]);
}

/* ---------------- stdio 传输 ---------------- */
export async function startStdioServer(){
  const token = process.env.REMIX_TOKEN;
  if (!token){
    console.error("[mcp] 缺少 REMIX_TOKEN 环境变量（个人 API Token）");
    process.exit(1);
  }
  const user = await A.userFromBearer({ headers: { authorization: "Bearer " + token } });
  if (!user){
    console.error("[mcp] Token 无效、已撤销或已过期");
    process.exit(1);
  }

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0){
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(line);
    }
  });

  async function handleLine(line){
    let msg;
    try { msg = JSON.parse(line); } catch(e){ return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } }); }
    const id = msg.id ?? null;
    if (!msg.method) return;
    try {
      const result = await dispatch(msg.method, msg.params, user, null);
      if (msg.method.startsWith("notifications/") || result === null) return;
      write({ jsonrpc: "2.0", id, result });
    } catch(e){
      write({ jsonrpc: "2.0", id, error: { code: e.rpcCode || -32603, message: String(e.message || e) } });
    }
  }
  function write(obj){
    process.stdout.write(JSON.stringify(obj) + "\n");
  }
  console.error(`[mcp] stdio 就绪 · 账号 ${user.username} · 工具 ${TOOLS.length} 个`);
}
