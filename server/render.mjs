/**
 * 渲染引擎 —— 按 shortvideo-mixcut 的工作流做，不是「一句一镜轮播素材」。
 *
 * 主链：
 *   整段配音（带字格）→ 自动分镜规划（平均 2.0–2.6s/镜，短句合并，切点吸字）
 *   → 每镜超采样渲染（1.5 倍画布 zoompan，推/拉/横移/摇，统一调色）
 *   → CFR 重编码拼接 → 渐变遮罩 + 字幕（断行 + 关键词金色高亮）+ 闪白 + 落版
 *   → 人声/BGM 按 RMS 归一混音 → loudnorm 母带 → 自动质检
 *
 * 与旧版的差别一句话：镜头数不再等于句数，素材不再按下标轮播，
 * 每一刀都落在字的起点上，整条片子只有一种 look。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { run, probe, BIN, extOf, VIDEO_EXT, IMAGE_EXT } from "./util.mjs";
import { synthesize, DEFAULT_VOICE, TAIL_MS } from "./tts.mjs";
import { planShots, planSummary } from "./plan.mjs";
import { buildAss, buildSrt, splitScriptEx, KEYWORD_RE } from "./subs.mjs";
import { alignVoiceCues } from "./voice-align.mjs";
import { analyzeReference, refAnchors, refSummary, resolveLocal } from "./refvideo.mjs";
import { synthesizeClone, cloneReadiness, separateBgm } from "./clone.mjs";
import { synthesizeCloud, cloudStatus, CLOUD_GAP_MS } from "./cloudvoice.mjs";

export const OUT_W = 1080, OUT_H = 1920, FPS = 30;

/** 1.5 倍超采样画布：推近镜头靠它不发虚 */
const BIG_W = 1620, BIG_H = 2880;

/** skill 默认调色链：一条片子只能有一种 look，别逐镜调 */
const GRADE = [
  "eq=contrast=1.15:brightness=0.006:saturation=1.12:gamma=1.0",
  "curves=preset=medium_contrast",
  "colorbalance=bs=0.022:rs=0.014:rm=0.010:bm=0.010",
  "unsharp=5:5:0.70:5:5:0.0",
  "vignette=PI/6.5"
];

/** 渐变遮罩：字幕已上移到画面中部，遮罩只做轻微压暗，不再当黑条用 */
const GRAD_H = 620, GRAD_A = 0.45;

/**
 * 把「字幕短句级」的时间轴归回「用户原句级」。
 *
 * 配音/字幕是按 ≤14 字一屏切的（屏幕节奏），镜头要的是一整句话（说话节奏）。
 * 只有在字幕条数与配音条目一一对应时才归 —— 别的配音来源（你传的音频、参考原声）
 * 条目数未必对得上，那时就用它原本的时间轴，不硬凑。
 */
function sentencesFromItems(rawLines, pieces, items){
  if (!Array.isArray(items) || !items.length) return items || [];
  if (items.length !== pieces.length) return items;
  const byOwner = new Map();
  pieces.forEach((p, i) => {
    if (!byOwner.has(p.owner)) byOwner.set(p.owner, []);
    byOwner.get(p.owner).push(items[i]);
  });
  const out = [];
  rawLines.forEach((txt, k) => {
    const seg = (byOwner.get(k) || []).filter(Boolean);
    if (!seg.length) return;
    out.push({
      i: out.length,
      text: txt,
      t0: seg[0].t0,
      t1: seg[seg.length - 1].t1,
      subs: seg.length
    });
  });
  return out.length ? out : items;
}

export async function render(cfg, ctx){
  const { runDir, onStage, log } = ctx;
  fs.mkdirSync(runDir, { recursive: true });

  /* ---------- s1 素材 ---------- */
  onStage("s1", "running");
  const rawLines = (cfg.script || []).map(s => String(s).trim()).filter(Boolean);
  if (!rawLines.length) throw new Error("文案为空");
  // 整段粘进一个格子的文案在这里切开：一句一条字幕，不然全片就一条字幕糊屏
  const pieces = splitScriptEx(rawLines);
  const lines = pieces.map(p => p.text);
  // 配音文本与字幕短句同源：splitScript 只切、不增删改字，拼回去就是用户原文。
  // 这样 buildWhole 逐字定位必命中，字幕时间轴和配音严格对齐，也不会再被补逗号带出乱停顿。
  const rawText = lines.join("");
  if (rawLines.length === 1 && lines.length > 1)
    log(`整段文案已自动切句：${lines.length} 条（原输入没有分行）`);
  if (lines.length > 120) throw new Error("文案超过 120 句，请拆分");

  const mats = [];
  for (const f of (cfg.files || [])){
    // 统一转绝对路径：后面 ffmpeg 全部以 runDir 为 cwd，相对路径会找不到
    const file = path.isAbsolute(f) ? f : path.resolve(f);
    if (!fs.existsSync(file)) { log(`素材缺失，已跳过：${path.basename(file)}`); continue; }
    const ext = extOf(file);
    const isImg = IMAGE_EXT.has(ext);
    if (!isImg && !VIDEO_EXT.has(ext)) { log(`不支持的格式，已跳过：${path.basename(file)}`); continue; }
    const p = isImg ? null : await probe(file);
    if (!isImg && (!p || !p.hasVideo)) { log(`无法解码，已跳过：${path.basename(file)}`); continue; }
    mats.push({ file, isImg, duration: p?.duration || 0, w: p?.width || 0, h: p?.height || 0 });
    // 横版 1080p 裁 9:16 只有 607x1080，放大 1.78 倍必糊 —— 提醒换素材
    if (!isImg && p && p.width > p.height && p.height < 1400)
      log(`提示：${path.basename(f)} 为横版低分辨率（${p.width}x${p.height}），裁竖版后会发虚`);
  }
  if (!mats.length) throw new Error("没有可用素材（请上传视频或图片）");
  log(`素材 ${mats.length} 段 · 文案 ${lines.length} 句`);

  /* ---------- 参考素材分析：参考视频 / 参考配音 / 参考BGM / 参考封面 ---------- */
  const refVideo = cfg.refVideo
    ? await analyzeReference(cfg.refVideo, runDir)
    : { ok: false, reason: "未填" };
  if (cfg.refVideo){
    if (refVideo.ok) log(`参考视频已接入：${refSummary(refVideo)}`);
    else log("参考视频未生效：" + refVideo.reason);
  }
  const refVO = cfg.refVO
    ? await analyzeReference(cfg.refVO, runDir)
    : { ok: false, reason: "未填" };
  if (cfg.refVO){
    if (refVO.ok) log(`参考配音已接入：${refSummary(refVO)}（音色不能克隆，按它的语速与停顿校准）`);
    else log("参考配音未生效：" + refVO.reason);
  }
  // 配音节奏的基准：优先参考配音，其次参考视频（只有参考里有说话段才作数）
  const voiceRef = refVO.ok ? refVO : (refVideo.ok && refVideo.hasSpeech ? refVideo : null);
  onStage("s1", "done");

  /* ---------- s2 配音：整段一次合成 ---------- */
  onStage("s2", "running");
  const voice = cfg.voice || DEFAULT_VOICE;
  let speed = Number(cfg.speed || 1);
  // 开关：直接用参考视频的完整音轨当成片唯一音轨。
  // 人声 + BGM 都在里面，所以不再本地合成配音、不再单独混 BGM；
  // 字幕沿用参考片同名 .ass 的时间轴，三者严格对齐。
  // ---- 内置默认音轨（defaults/：参考片扒下来的配音 / BGM / 字幕）----
  const DEF_DIR = path.join(process.cwd(), "defaults");
  const DEF_VO = path.join(DEF_DIR, "vo.m4a");
  const DEF_BGM = path.join(DEF_DIR, "bgm.mp3");
  const DEF_SUB = path.join(DEF_DIR, "sub.ass");
  const assTimeMs = v => {
    const m = /^(\d+):(\d+):(\d+)[.,](\d+)$/.exec(String(v || "").trim());
    return m ? ((+m[1] * 3600) + (+m[2] * 60) + (+m[3])) * 1000 + (+m[4]) * 10 : 0;
  };
  const parseAssCues = file => {
    if (!file || !fs.existsSync(file)) return [];
    const out = [];
    for (const ln of fs.readFileSync(file, "utf8").split(/\r?\n/)){
      if (!String(ln).startsWith("Dialogue:")) continue;
      const f = ln.slice(9).split(",");
      if (f.length < 10) continue;
      const st = assTimeMs(f[1]), en = assTimeMs(f[2]);
      const tx = f.slice(9).join(",").replace(/\{[^}]*\}/g, "").replace(/\\N/g, " ").trim();
      if (en > st && tx) out.push({ start: st, end: en, text: tx });
    }
    return out;
  };
  const useRefAudio = !!cfg.useRefAudio && refVideo.ok;
  // 用户自己给的配音音频（WorkBuddy 那边配音后丢过来的文件）：整条当人声，网站不再合成。
  // 用真实停顿定位段落边界，段内按字数排字幕；没有可用停顿时均匀铺到音频结尾。
  const voFileRaw = resolveLocal(cfg.voFile);
  const voFile = voFileRaw && fs.existsSync(voFileRaw) ? voFileRaw : null;
  if (cfg.voFile && !voFile) log(`配音音频路径不存在，已忽略：${cfg.voFile}`);
  const useVoFile = !useRefAudio && !!voFile;
  // 本机克隆音色：服务端自己跑 F5 / GPT-SoVITS，不经 WorkBuddy。
  // 云端音色：网页「配音音色」里选的火山豆包 2.0，走 cloud-tts.mjs，不装本机权重。
  // 优先级不变：给了配音文件 > 参考原声 > 本机克隆 > 云端 > 内置默认 > 系统音色。
  const useClone = !useRefAudio && !useVoFile && !!cfg.cloneVoice;
  const useCloud = !useRefAudio && !useVoFile && !useClone && !!cfg.cloudVoice;
  const useDefaultAudio = !useRefAudio && !useVoFile && !useClone && !useCloud
    && cfg.useDefaultAudio !== false && fs.existsSync(DEF_VO);
  let tts;
  if (useVoFile){
    const vInfo = await probe(voFile);
    const vDur = Math.max(500, Math.round((vInfo?.duration || 0) * 1000));
    const a = await analyzeReference(voFile, runDir);
    const aligned = alignVoiceCues(lines, vDur, a);
    const items = aligned.items;
    log(`配音：沿用你给的音频（${(vDur / 1000).toFixed(2)}s）· ${aligned.alignedPauses} 个段落停顿用于字幕对齐，其余按字数铺排`);
    tts = {
      engine: "file", mode: "whole", audio: voFile, totalMs: vDur,
      items, charTimes: items.map(it => it.t0), leadMs: 0,
      note: ["配音直接用你提供的音频，未做任何合成与变声"]
    };
  } else if (useClone){
    /* 本机克隆音色：服务端直接跑 F5，不连 WorkBuddy、不派单、不人工干预。
       耗时按 274 字约 12 分钟算（纯 CPU），进度写进任务日志让用户能看见在动。 */
    const ready = cloneReadiness();
    if (!ready.ok) throw Object.assign(new Error("选了克隆音色但本机跑不起来：" + ready.missing.join("；")), { code: 409 });
    const cl = await synthesizeClone({
      voiceKey: cfg.cloneVoice,
      script: rawText,
      lines,                       // 一行一句：逐行合成才能真正在句间断开
      perLine: cfg.perLine !== false,
      speed,
      workDir: path.join(runDir, "clone"),
      onLog: m => log(m)
    });
    const vDur = Math.max(500, cl.durMs || Math.round((await probe(cl.vo))?.duration * 1000));
    // 逐行合成时段边界就是行边界，时间轴由合成侧直接给出，
    // 不用再拿静音检测去猜——连读的音频里根本猜不出来，只能退化成按字数硬铺。
    let items;
    if (Array.isArray(cl.items) && cl.items.length === lines.length && cl.items.every(it => it.t1 > it.t0)){
      items = cl.items;
      log(`配音：本机克隆（${(vDur / 1000).toFixed(2)}s）· ${items.length} 句逐句对齐（${(cl.gapMs || 0)}ms 句间停顿）`);
    } else {
      const a = await analyzeReference(cl.vo, runDir);
      const aligned = alignVoiceCues(lines, vDur, a);
      items = aligned.items;
      log(`配音：本机克隆（${(vDur / 1000).toFixed(2)}s）· ${aligned.alignedPauses} 个段落停顿用于字幕对齐`);
    }
    tts = {
      engine: "clone", mode: "whole", audio: cl.vo, totalMs: vDur,
      items, charTimes: items.map(it => it.t0), leadMs: 0,
      note: cl.note
    };
    // 克隆音色默认不叠伴奏：要 BGM 就在「更多剪辑设置」里显式选一条。
    // 档案里那份 bgm.mp3 不再自动接上——用户明确要求克隆只出人声。
    if (useClone && !cfg.bgm){
      cfg.disableBgm = true;
      log("BGM：克隆音色默认不加伴奏，需要的话在「更多剪辑设置 → 使用已保存的 BGM」里选");
    }
  } else if (useRefAudio){
    const dur = Math.round((refVideo.duration || 0) * 1000);
    const segs = (refVideo.speech || []).filter(s => s.e > s.s);
    const slots = segs.length ? segs : [{ s: 0, e: dur / 1000 }];
    const items = slots.map((s, i) => ({
      i, text: lines[i] || "", t0: Math.round(s.s * 1000), t1: Math.round(s.e * 1000)
    }));
    tts = {
      engine: "ref", mode: "whole", audio: refVideo.path,
      totalMs: dur, items, charTimes: refAnchors(refVideo), leadMs: 0,
      note: [`配音与 BGM 直接沿用参考视频原声（${(dur / 1000).toFixed(1)}s），未本地合成`]
    };
    log(`已套用参考视频原声：配音 + BGM 整轨沿用 · ${(dur / 1000).toFixed(2)}s · ${items.length} 个语音段`);
  } else if (useDefaultAudio){
    // 默认配音轨：参考片扒下来的人声，字幕时间轴也来自参考片
    const vInfo = await probe(DEF_VO);
    const vDur = Math.round((vInfo?.duration || 0) * 1000);
    const dCues = parseAssCues(fs.existsSync(DEF_SUB) ? DEF_SUB : null);
    let dItems;
    if (dCues.length){
      dItems = dCues.map((c, i) => ({ i, text: c.text, t0: c.start, t1: c.end }));
    } else {
      // 没有配套字幕：按 2.4s 均分镜头区间，不烧字幕，避免一条字幕贯穿全片
      dItems = [];
      for (let t = 0; t < vDur; t += 2400){
        dItems.push({ i: dItems.length, text: "", t0: t, t1: Math.min(vDur, t + 2400) });
      }
    }
    tts = {
      engine: "default", mode: "whole", audio: DEF_VO,
      totalMs: vDur, items: dItems, charTimes: dItems.map(it => it.t0), leadMs: 0,
      note: [`配音：内置默认音轨（参考片原声，${(vDur / 1000).toFixed(1)}s），未本地合成`]
    };
    log(`使用内置默认配音：${(vDur / 1000).toFixed(2)}s · ${dItems.length} 条字幕时间轴`);
  } else if (useCloud){
    /* 网页云端配音：一行一句合成，句间留 0.45s（已验收的节奏口径）。
       产出与 synthesizePerLine 同结构，后面的分镜/字幕/BGM 全部复用。 */
    const st = cloudStatus();
    if (!st.ready)
      throw Object.assign(new Error("选了云端音色但云端服务不可用：" + st.missing.join("；")), { code: 409 });
    tts = await synthesizeCloud(lines, {
      voice: cfg.cloudVoice,
      speed,
      gapMs: CLOUD_GAP_MS,
      workDir: path.join(runDir, "cloud")
    });
    log(`配音：云端 ${st.provider === "volc" ? "火山豆包 2.0" : "edge"} · ${cfg.cloudVoice} · ${tts.items.length} 句逐句对齐（${CLOUD_GAP_MS}ms 句间停顿）`);
    // tts.note 由下面所有分支共用的那段统一打印，这里别重复
  } else {
  tts = await synthesize(lines, {
    voice, speed, pitch: cfg.pitch, gapMs: cfg.gapMs, wholeText: rawText,
    // 一行一句一断：逐行合成，句间留 0.35s 以上的真实停顿
    perLine: cfg.perLine !== false
  });
  // 按参考的说话节奏校准语速。
  // 注意不能用「总跨度比」——参考片 34s 对我们 4 句短文案，会把语速顶到 1.6×，那是错的。
  // 正确口径有两个，先用更本质的那个：
  //   ① 有参考文案（同目录同名 txt/srt/ass）→ 比「字/秒」，这才是语速本身
  //   ② 没有文案 → 比「每句平均时长」（参考每段说话 vs 我们每句），只做温和修正
  // 前置：参考里得真检出「说话段」。抖音下来的参考配音是「人声 + BGM 糊在一起」，
  // 静音检测切不出段，speech 会退化成「整条一段」，再拿它算每段时长必然算反
  // （29.5s 一段 vs 我们 2.2s 一句 → 语速被调慢到 0.85×）。所以检测不可靠就直接不校准。
  const refUsable = !!voiceRef && voiceRef.spanMs > 1500
    && (voiceRef.hasSpeech === true || !!voiceRef.refText);
  if (voiceRef && !refUsable){
    log(`参考「${path.basename(voiceRef.source || voiceRef.path || "参考音频")}」里听不出换气口（人声和 BGM 糊在一起），本次不按它校准语速，保持 ${speed.toFixed(2)}×`);
  }
  if (refUsable && tts.items.length){
    const ourSpan = Math.max(500, tts.items[tts.items.length - 1].t1 - tts.items[0].t0);
    const ourChars = lines.reduce((a, l) => a + String(l).replace(/\s/g, "").length, 0);
    const refCps = voiceRef.refText ? (voiceRef.refText.chars / (voiceRef.spanMs / 1000)) : 0;
    const ourCps = ourChars / (ourSpan / 1000);
    const refPerSeg = voiceRef.spanMs / Math.max(1, voiceRef.speech.length);
    const ourPerLine = ourSpan / tts.items.length;

    let ratio = null, how = "";
    if (refCps > 0.5 && ourCps > 0.5){
      ratio = refCps / ourCps;                 // 参考字/秒 ÷ 我们字/秒
      how = `参考 ${refCps.toFixed(2)} 字/秒 · 我们 ${ourCps.toFixed(2)} 字/秒`;
    } else {
      ratio = ourPerLine / refPerSeg;         // 我们每句长 ÷ 参考每段长
      how = `参考每段 ${(refPerSeg / 1000).toFixed(2)}s · 我们每句 ${(ourPerLine / 1000).toFixed(2)}s`;
    }
    // 限幅：只做温和修正，别把语速推到失真区间
    const ns = Math.max(0.85, Math.min(1.6, +(speed * ratio).toFixed(2)));
    if (Math.abs(ns - speed) >= 0.04){
      log(`按参考校准配音语速 ${speed.toFixed(2)}× → ${ns.toFixed(2)}×（${how}）`);
      tts = await synthesize(lines, {
        voice, speed: ns, pitch: cfg.pitch, gapMs: cfg.gapMs, wholeText: rawText
      });
      speed = ns;
    } else {
      log(`配音语速与参考基本一致，保持 ${speed.toFixed(2)}×（${how}）`);
    }
  }
  }
  for (const n of tts.note) log(n);
  const totalMs = Math.max(1000, tts.totalMs);
  log(`配音引擎：${tts.engine}${tts.mode === "whole" ? " · 整段合成" : ""} · 总时长 ${(totalMs / 1000).toFixed(2)}s`);
  onStage("s2", "done", tts.engine === "none" ? "无配音" : `${tts.engine}`);

  /* ---------- s3 BGM ---------- */
  onStage("s3", "running");
  // 参考原声整轨（人声 + BGM 已经混好）→ 一个音都不许再叠、不许再加工。
  // 之前只判了 useRefAudio，默认音轨漏判：不但走 highpass/treble/压缩（把人声染亮、动态压扁），
  // 还会因为没指定 BGM 被 pickBgm 随机叠一首，两层 BGM 糊在一起，听感完全不是原片。
  const integratedTrack = useRefAudio || useDefaultAudio;   // 整轨自带 BGM
  const rawVoice = integratedTrack || useVoFile || useClone;   // 成品音轨：一律不加工
  let bgmFile = null, bgmExtraDb = 0;
  if (cfg.disableBgm){
    log("BGM：本次不使用背景音乐");
    onStage("s3", "done", "未使用");
  } else if (integratedTrack){
    if (cfg.bgm) log(`BGM：你填的 ${path.basename(String(cfg.bgm))} 没有叠加——原声整轨里已经自带 BGM，再叠会糊`);
    else log("BGM：原声整轨已含配音与背景音乐，跳过单独混音");
    onStage("s3", "done", "原声已含");
  } else {
  const explicitBgm = resolveLocal(cfg.bgm);
  if (explicitBgm && fs.existsSync(explicitBgm)){
    if (VIDEO_EXT.has(path.extname(explicitBgm).toLowerCase())){
      const a = await analyzeReference(explicitBgm, runDir);
      if (a.ok){ bgmFile = a.path; log(`BGM：从参考视频抽音轨（${path.basename(explicitBgm)}）`); }
      else log("BGM 抽取失败：" + a.reason);
    } else {
      bgmFile = explicitBgm;
      log(`BGM：${path.basename(bgmFile)}`);
    }
  } else if (cfg.bgm){
    log(`BGM 路径不存在，已忽略：${cfg.bgm}`);
  }
  // 没单独指定 BGM，就沿用参考视频的音轨 —— 但要把人声剥掉。
  // 以前是整条原声压低 9dB 当背景床，那条轨里还有参考视频的人在说话，
  // 跟我们的配音叠在一起就是两层人声糊住，所以现在先跑一次 HDEMUCS 只留伴奏。
  if (!bgmFile && refVideo.ok){
    if (cfg.useRefBgm !== false){
      try {
        const sep = await refVideoBgm(refVideo, runDir, log);
        if (sep){ bgmFile = sep; bgmExtraDb = 0; }
      } catch(e){
        log("参考视频的伴奏没分离出来，退回整条原声压低当背景：" + e.message);
      }
    }
    if (!bgmFile){
      bgmFile = refVideo.path;
      if (refVideo.hasSpeech){
        bgmExtraDb = -9;
        log("BGM：沿用参考视频音轨（含人声，压低 9dB 作背景床，可能有串音）");
      } else {
        log("BGM：沿用参考视频音轨（纯音乐）");
      }
    }
  }
  if (!bgmFile && useDefaultAudio && fs.existsSync(DEF_BGM)){
    bgmFile = DEF_BGM;
    log("BGM：内置默认（与默认配音配套）");
  }
  if (!bgmFile) bgmFile = pickBgm({ ...cfg, bgm: "" }, runDir);
  if (bgmFile) { log(`BGM 音量基准 -24dB${bgmExtraDb ? ` · 参考人声再压 ${bgmExtraDb}dB` : ""}`); onStage("s3", "done", "已加载"); }
  else onStage("s3", "done", "无 BGM");
  }

  /* ---------- s4 分镜规划 + 渲染 ---------- */
  onStage("s4", "running");
  // 镜头按「用户的一句」切，不按字幕短句切：字幕是 ≤14 字一屏的屏幕节奏，
  // 拿它切镜头会把一句话劈成 2–3 刀，看起来就是「一直在切」。
  // 这里把字幕短句按 owner 归回原句，一句一镜，切点落在句界（气口）。
  const unitItems = sentencesFromItems(rawLines, pieces, tts.items);
  if (unitItems.length && unitItems.length !== tts.items.length)
    log(`分镜按原句切：${tts.items.length} 条字幕 → ${unitItems.length} 句`);
  const shots = planShots(unitItems, mats, totalMs, tts.charTimes, cfg);
  const ps = planSummary(shots, totalMs);
  log(`分镜规划：${ps.text}`);
  const strictShot = String(cfg.shotsMode || "exact") === "exact";
  log(`分镜规则：${strictShot ? "一行一镜（严格：短句不并、长句不补刀）" : "一句一镜（短句并镜）"}、切点落在句界气口上、素材按选择顺序对应；成片 ${(totalMs / 1000).toFixed(2)}s 以配音为准`);

  const shotDir = path.join(runDir, "shots");
  fs.mkdirSync(shotDir, { recursive: true });
  const shotFiles = [];
  for (let i = 0; i < shots.length; i++){
    const s = shots[i];
    const dur = (s.t1 - s.t0) / 1000;
    const n = Math.max(2, Math.round(dur * FPS));
    const out = path.join(shotDir, `s${String(i).padStart(2, "0")}.mp4`);
    const vf = shotVf(s, n, i === shots.length - 1, cfg);
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    if (s.isImg) args.push("-loop", "1", "-framerate", String(FPS), "-t", dur.toFixed(3), "-i", s.clip);
    else args.push("-stream_loop", "-1", "-i", s.clip);
    args.push("-an", "-vf", vf, "-frames:v", String(n),
      "-r", String(FPS),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", out);

    const r = await run(BIN.ffmpeg, args, { cwd: runDir });
    if (r.code !== 0 || !fs.existsSync(out)){
      throw new Error(`分镜 ${i + 1} 生成失败：${lastErr(r.err)}`);
    }
    shotFiles.push(out);
    onStage("s4", i === shots.length - 1 ? "done" : "running", `${i + 1}/${shots.length}`);
    log(`分镜 ${i + 1}/${shots.length} · ${dur.toFixed(2)}s · ${s.move} · ${path.basename(s.clip)}`);
  }

  /* ---------- s5 字幕 ---------- */
  onStage("s5", "running");
  const cues = tts.items.map(it => ({ start: it.t0, end: it.t1, text: it.text }));
  const srt = path.join(runDir, "subtitle.srt");
  fs.writeFileSync(srt, buildSrt(cues), "utf8");
  const ass = path.join(runDir, "burn.ass");
  // 套用参考原声时，字幕直接用参考视频同名 .ass：时间轴与那条音轨天然一致
  const refAss = (() => {
    if (!useRefAudio || !cfg.refVideo) return null;
    const p2 = path.resolve(cfg.refVideo);
    const a = path.join(path.dirname(p2), path.basename(p2, path.extname(p2)) + ".ass");
    return fs.existsSync(a) ? a : null;
  })();
  const subSrc = refAss || (useDefaultAudio && fs.existsSync(DEF_SUB) ? DEF_SUB : null);
  if (subSrc){
    fs.copyFileSync(subSrc, ass);
    log(`字幕：沿用参考字幕 ${path.basename(subSrc)}（时间轴与配音一致）`);
  } else if (useDefaultAudio){
    // 默认音轨没有配套字幕：写空字幕文件（libass 不渲染任何内容）
    fs.writeFileSync(ass, "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n", "utf8");
    log("字幕：默认音轨无配套字幕，本次不烧字幕");
  } else {
    const subFx = cfg.subFx !== false;
    fs.writeFileSync(ass, buildAss(cues, {
      font: cfg.font || "Microsoft YaHei", size: cfg.subSize || 78,
      intro: subFx, kw: subFx
    }), "utf8");
    const kwN = cues.filter(c => String(c.text || "").match(KEYWORD_RE)).length;
    log(`字幕 ${cues.length} 条 · 字体 ${cfg.font || "Microsoft YaHei"} · 单行短句`
      + (subFx ? ` · 开场呐喊 + 声波 · ${kwN} 条带关键词划重点` : " · 无字幕特效"));
  }
  onStage("s5", "done", `${cues.length} 条`);

  /* ---------- s6 封面 ---------- */
  onStage("s6", "running");
  const cover = path.join(runDir, "cover.jpg");
  const refCoverPath = resolveLocal(cfg.refCover);
  let coverFromRef = false;
  if (refCoverPath && fs.existsSync(refCoverPath)){
    const ext = path.extname(refCoverPath).toLowerCase();
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    if (IMAGE_EXT.has(ext)) args.push("-loop", "1", "-t", "1", "-i", refCoverPath);
    else args.push("-ss", "0.5", "-i", refCoverPath);
    args.push("-vf", `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H}`,
      "-frames:v", "1", "-update", "1", "-q:v", "3", cover);
    const rc = await run(BIN.ffmpeg, args, { cwd: runDir, timeout: 120000 });
    if (rc.code === 0 && fs.existsSync(cover) && fs.statSync(cover).size > 1000){
      coverFromRef = true;
      log("封面：沿用参考封面 " + path.basename(refCoverPath));
    } else {
      log("参考封面处理失败，回退自动生成");
    }
  }
  if (!coverFromRef){
    await makeCover(runDir, shotFiles, cfg.title || "", cover, cfg.font || "Microsoft YaHei")
      .then(e => { if (e) log("封面降级：" + e); });
  }
  onStage("s6", "done", fs.existsSync(cover) ? "已生成" : "跳过");

  /* ---------- s7 终合成 ---------- */
  onStage("s7", "running");
  const total = totalMs / 1000;

  // 1) CFR 重编码拼接。不能 -c copy：时间戳跳变会把渐变遮罩打漏
  const concatList = path.join(runDir, "concat.txt");
  fs.writeFileSync(concatList,
    shotFiles.map(f => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  const concatOut = path.join(runDir, "concat.mp4");
  let r = await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", concatList,
    "-vf", `fps=${FPS},format=yuv420p`,
    "-r", String(FPS), "-fps_mode", "cfr",
    "-c:v", "libx264", "-preset", "medium", "-crf", "14",
    "-an", concatOut], { cwd: runDir });
  if (r.code !== 0) throw new Error("分镜拼接失败：" + lastErr(r.err));

  // 2) 渐变遮罩 PNG：单帧图必须 stream_loop 循环，否则只有第一秒有遮罩
  const grad = path.join(runDir, "grad.png");
  r = await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=black:s=${OUT_W}x${GRAD_H}`,
    "-vf", `format=rgba,geq=r=0:g=0:b=0:a='${Math.round(GRAD_A * 255)}*pow(Y/${GRAD_H - 1},1.0)'`,
    "-frames:v", "1", grad], { cwd: runDir });
  if (r.code !== 0) throw new Error("渐变遮罩生成失败：" + lastErr(r.err));

  // 3) 配音：整段一个文件，前面补 lead 静音，后面补到片长
  // 套用参考原声时直接喂整轨，不再补静音、不再改响度
  const narr = useRefAudio ? refVideo.path : await buildNarration(runDir, tts, totalMs);
  // 原声整轨不做任何增益：多一分贝都不是原片那个声音了
  const voGain = rawVoice ? 0 : await rmsGain(narr, -15);
  const bgmGain = bgmFile ? await rmsGain(bgmFile, -24) + bgmExtraDb : 0;

  // 4) 组装 filter graph
  let inN = 0;
  const inputs = [];
  const addInput = (...a) => { inputs.push(...a); return inN++; };
  addInput("-i", concatOut);
  addInput("-stream_loop", "-1", "-framerate", String(FPS), "-i", grad);
  const AUD = narr ? addInput("-i", narr)
    : addInput("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  const BGM = bgmFile ? addInput("-stream_loop", "-1", "-i", bgmFile) : -1;

  // 闪白时间点算一次：画面用它打 drawbox，音效用它铺 whoosh，两处必须同源
  const flashTs = flashTimes(shots, total);
  // 点睛音效：开场呐喊一下、关键词叮最多 3 下、转场一阵风、结尾落版一下
  const sfxEvents = cfg.sfx === false ? [] : buildSfxPlan(cues, total, flashTs);
  if (cfg.sfx === false) log("音效：本次不加点睛音效");
  else if (!sfxEvents.length) log("音效：defaults/sfx 里没有素材，本次跳过");
  else log(`音效 ${sfxEvents.length} 处：${sfxEvents.map(e => `${path.basename(e.file, ".wav")}@${(e.at / 1000).toFixed(1)}s`).join(" ")}`);

  const fc = [];
  const vchain = [
    `fade=t=in:st=0:d=0.14`,
    `fade=t=out:st=${Math.max(0, total - 0.42).toFixed(2)}:d=0.42`,
    ...flashFades(flashTs)
  ];
  const flashes = flashTs.length;
  if (flashes) log(`闪白 ${flashes} 处（段落转折）`);
  fc.push(`[0:v]${vchain.join(",")}[base]`);
  fc.push(`[1:v]format=rgba[grad]`);
  fc.push(`[base][grad]overlay=x=0:y=main_h-overlay_h[ov]`);
  fc.push(`[ov]ass=burn.ass[v]`);

  // 人声：只有「网站自己念文案」时才做高通 + 提亮 + 压缩。
  // 参考原声整轨一律原样过，连 aformat 之外的东西都不加 —— 用户要的就是那个人原声。
  const vo = rawVoice ? [
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    "apad", `atrim=0:${total.toFixed(3)}`
  ] : [
    `highpass=f=90`,
    `treble=g=1.2:f=2800`,
    `acompressor=threshold=-18dB:ratio=3:attack=5:release=120`,
    ...(voGain ? [`volume=${voGain.toFixed(2)}dB`] : []),
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    "apad", `atrim=0:${total.toFixed(3)}`
  ];
  fc.push(`[${AUD}:a]${vo.join(",")}[vo]`);

  if (bgmFile){
    const bg = [
      ...(bgmGain ? [`volume=${bgmGain.toFixed(2)}dB`] : []),
      "bass=g=3.0:f=110", "treble=g=2.5:f=5000",
      `afade=t=in:st=0:d=0.6`,
      `afade=t=out:st=${Math.max(0, total - 0.7).toFixed(2)}:d=0.7`,
      "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
      "apad", `atrim=0:${total.toFixed(3)}`
    ];
    fc.push(`[${BGM}:a]${bg.join(",")}[bg]`);
  }

  // 点睛音效：每个音效单独 adelay 到自己的时间点，再混成一条轨，最后并进人声。
  // normalize=0 一路到底：否则 amix 会把每路按 1/N 衰减，人声会被音效「拉低」。
  let sfxLabel = null;
  if (sfxEvents.length){
    const tags = [];
    sfxEvents.forEach((e, k) => {
      const i = addInput("-i", e.file);
      fc.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,`
        + `volume=${e.db}dB,adelay=${Math.round(e.at)}:all=1[sx${k}]`);
      tags.push(`[sx${k}]`);
    });
    fc.push(`${tags.join("")}amix=inputs=${tags.length}:duration=longest:normalize=0[sfx]`);
    sfxLabel = "[sfx]";
  }

  const mixIn = ["[vo]"];
  if (bgmFile) mixIn.push("[bg]");
  if (sfxLabel) mixIn.push(sfxLabel);
  if (mixIn.length === 1) fc.push(`[vo]anull[mix]`);
  // duration=first：以人声轨（已 apad/atrim 到片长）为准，音效尾巴不会把片子撑长
  else fc.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:duration=first:dropout_transition=0:normalize=0[mix]`);
  fc.push(`[mix]loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]`);

  const video = path.join(runDir, "video.mp4");
  const args = ["-y", "-hide_banner", "-loglevel", "error", ...inputs,
    "-filter_complex", fc.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-t", total.toFixed(3), "-r", String(FPS),
    "-c:v", "libx264", "-preset", "medium", "-crf", "21",
    "-maxrate", "16M", "-bufsize", "32M",
    "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1",
    "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    video];
  r = await run(BIN.ffmpeg, args, { cwd: runDir });
  if (r.code !== 0 || !fs.existsSync(video)) throw new Error("终合成失败：" + lastErr(r.err));
  onStage("s7", "done");

  /* ---------- s8 质检 ---------- */
  onStage("s8", "running");
  const info = await probe(video);
  const problems = [];
  if (!info) problems.push("成片无法解析");
  else {
    if (!info.hasVideo) problems.push("缺少视频流");
    if (!info.hasAudio) problems.push("缺少音频流");
    if (info.width !== OUT_W || info.height !== OUT_H) problems.push(`分辨率 ${info.width}x${info.height}`);
    const drift = Math.abs(info.duration - total);
    if (drift > 0.6) problems.push(`时长偏差 ${drift.toFixed(2)}s`);
  }
  // 黑帧 / 冻结 / 响度实测，对照 skill 的交付红线
  if (await hasBlack(video)) problems.push("检出黑帧");
  if (await hasFreeze(video)) problems.push("检出画面冻结");
  const loud = await measureLoudness(video);
  if (loud){
    if (Math.abs(loud.I + 14) > 1.5) problems.push(`响度 ${loud.I.toFixed(1)} LUFS`);
    if (loud.TP > -1.0) problems.push(`真峰 ${loud.TP.toFixed(1)} dBTP`);
    log(`响度 ${loud.I.toFixed(1)} LUFS · 真峰 ${loud.TP.toFixed(1)} dBTP · LRA ${loud.LRA}`);
  }

  if (problems.length){
    log("质检：" + problems.join("、"));
    onStage("s8", "done", problems[0]);
  } else {
    log(`质检通过 · ${info.width}x${info.height} · ${info.duration.toFixed(2)}s · ${ps.text}`);
    onStage("s8", "done", "通过");
  }

  return {
    video, cover: fs.existsSync(cover) ? cover : null, srt,
    duration: info?.duration || total,
    width: info?.width, height: info?.height, fps: info?.fps,
    // 克隆 / 云端模式下 cfg.voice 是空的，别把音色误标成默认系统音色
    ttsEngine: tts.engine, ttsMode: tts.mode,
    voice: useClone ? `clone:${cfg.cloneVoice}` : (useCloud ? `cloud:${cfg.cloudVoice}` : voice),
    lines: cues.length, shots: shots.length,
    plan: ps,
    warnings: [...tts.note, ...problems]
  };
}

/* ---------------- 单镜滤镜 ---------------- */

/**
 * 一镜的完整滤镜链：裁切 → 超采样 → 运镜 → 调色。
 * 顺序不能反：先 scale 到 1.5 倍画布再 zoompan，等于超采样；
 * 反过来（先 zoompan 后 scale）是像素插值放大，必糊。
 */
function shotVf(s, n, isLast, cfg){
  const parts = [];

  // 取段（图片没有 trim 的概念，走 -t）
  if (!s.isImg && s.in > 0) parts.push(`trim=start=${s.in.toFixed(2)}:duration=${((s.t1 - s.t0) / 1000).toFixed(3)}`, "setpts=PTS-STARTPTS");

  // 9:16 裁切窗口：竖裁只能覆盖原图高度的 56%，横版 fy 无效只有 fx 起作用
  if (s.w && s.h){
    const outR = OUT_W / OUT_H;
    const srcR = s.w / s.h;
    let cw, ch;
    if (srcR > outR){ ch = s.h; cw = Math.min(s.w, s.h * outR); }
    else { cw = s.w; ch = Math.min(s.h, s.w / outR); }
    cw = Math.floor(cw / 2) * 2; ch = Math.floor(ch / 2) * 2;
    const x = Math.round((s.w - cw) * s.fx), y = Math.round((s.h - ch) * s.fy);
    parts.push(`crop=${cw}:${ch}:${x}:${y}`);
  }
  parts.push(`scale=${BIG_W}:${BIG_H}:flags=lanczos`, "setsar=1");

  // 运镜：禁止静帧，但幅度收到 6%。1.12 那种推拉会把近景再裁掉一圈，
  // 人脸/设备边缘被切掉就是「画面残缺」，宁可动得轻一点。
  const p = `on/${Math.max(1, n - 1)}`;
  const cx = `(iw-iw/zoom)/2`, cy = `(ih-ih/zoom)/2`;
  let z, x, y;
  switch (s.move){
    case "out":  z = `max(1.0,1.06-0.06*${p})`; x = cx; y = cy; break;
    case "panlr":z = "1.06"; x = `(iw-iw/zoom)*${p}`; y = cy; break;
    case "panrl":z = "1.06"; x = `(iw-iw/zoom)*(1-${p})`; y = cy; break;
    case "tiltu":z = "1.06"; x = cx; y = `(ih-ih/zoom)*(1-${p})`; break;
    case "in":
    default:     z = `min(1.06,1+0.06*${p})`; x = cx; y = cy; break;
  }
  parts.push(`zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${OUT_W}x${OUT_H}:fps=${FPS}`);

  // 统一调色。收尾镜不动 look，别为结尾单独调
  if (cfg.grade !== false) parts.push(...GRADE);
  parts.push(`fps=${FPS}`, "format=yuv420p");
  return parts.join(",");
}

/**
 * 段落转折处的闪白：3 帧、透明度 0.34/0.19/0.09 递减（硬起软收），全片不超过 3 处。
 *
 * 注意不能用 fade=...:color=white —— fade 的 st 只控制起点，st 之前的整段
 * 都会被涂成纯白（我们实测翻过车：字幕浮在全白画面上，质检还误报"画面冻结"）。
 * drawbox + enable 窗口才是逐帧可控的白闪。
 */
/** 段落转折的时间点（秒）：长镜起点、间隔 8s 以上、最多 3 处 */
function flashTimes(shots, total){
  if (shots.length < 4) return [];
  const cands = shots
    .filter(s => (s.t1 - s.t0) >= 2800)
    .map(s => s.t0 / 1000)
    .filter(t => t > 2.5 && t < total - 3);
  const out = [];
  let last = -99;
  for (const t of cands){
    if (t - last < 8) continue;
    out.push(t);
    last = t;
    if (out.length >= 3) break;
  }
  return out;
}

/** 三帧白闪：从 34% 迅速衰减，模拟一下「段落砸开」 */
function flashFades(times){
  const out = [];
  for (const t of times){
    [0.34, 0.19, 0.09].forEach((a, k) => {
      out.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white@${a}:t=fill:enable='between(t,${(t + k / FPS).toFixed(3)},${(t + (k + 1) / FPS).toFixed(3)})'`);
    });
  }
  return out;
}

/**
 * 点睛音效时间表。原则是「点睛」，不是音效库：只在真正该响的地方响一下。
 *   开场    impact + whoosh（字幕呐喊那一下）
 *   关键词  最多 3 次 ding（跟划重点同步，间隔不足 1.6s 就跳过，免得叮叮叮）
 *   闪白    whoosh 一阵风
 *   结尾    pop 落版
 * 素材在 defaults/sfx，缺哪个就少哪个，不影响出片。
 */
function buildSfxPlan(cues, total, flashTimes_){
  const dir = path.join(process.cwd(), "defaults", "sfx");
  const ev = [];
  const add = (n, at, db) => {
    const f = path.join(dir, n);
    if (!fs.existsSync(f)) return;
    ev.push({ file: f, at: Math.max(0, Math.round(at)), db });
  };

  add("impact.wav", 0, -13);
  add("whoosh.wav", 40, -19);

  let last = -9e9, n = 0;
  for (const c of cues){
    if (n >= 3) break;
    if (!String(c.text || "").match(KEYWORD_RE)) continue;
    if (c.start - last < 1600) continue;
    add("ding.wav", c.start + 40, -21);
    last = c.start;
    n++;
  }

  for (const t of (flashTimes_ || []).slice(0, 3)) add("whoosh.wav", t * 1000 - 120, -22);
  add("pop.wav", total * 1000 - 520, -17);
  return ev.sort((a, b) => a.at - b.at);
}

/* ---------------- 音频 ---------------- */

/** 配音轨。整段合成时就是一个文件前面补 lead；逐句兜底走拼接。 */
async function buildNarration(runDir, tts, totalMs){
  if (tts.engine === "none") return null;
  if (tts.mode === "whole" && tts.audio){
    const wav = path.join(runDir, "vo.wav");
    const lead = Math.max(0, tts.leadMs || 0);
    const r = await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error",
      "-i", tts.audio,
      "-af", `adelay=${lead}:all=1,apad`,
      "-t", (totalMs / 1000).toFixed(3),
      "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", wav]);
    return r.code === 0 && fs.existsSync(wav) ? wav : null;
  }

  // 逐句兜底：按每句时间铺静音底，再把句子垫到对应位置
  const items = tts.items.filter(x => x.file);
  if (!items.length) return null;
  const adir = path.join(runDir, "audio");
  fs.mkdirSync(adir, { recursive: true });
  const wav = path.join(runDir, "vo.wav");
  const parts = [];
  // 每句前面垫的静音必须是「相对上一句末尾」的间隔，不是绝对时间。
  // 原来写的是 it.t0 - items[0].t0（累计值），逐行配音时会越拼越长，出现 7 秒空洞。
  let prevEnd = items[0].t0;
  for (const it of items){
    const seg = path.join(adir, `a${String(it.i).padStart(3, "0")}.wav`);
    const r = await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error",
      "-i", it.file, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", seg]);
    if (r.code !== 0) continue;
    const lead = Math.max(0, it.t0 - prevEnd) / 1000;
    if (lead > 0.01){
      const pre = path.join(adir, `pre${String(it.i).padStart(3, "0")}.wav`);
      await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", lead.toFixed(3), "-c:a", "pcm_s16le", pre]);
      parts.push(pre);
    }
    parts.push(seg);
    prevEnd = it.t0 + (it.duration || Math.round((it.t1 - it.t0)));
  }
  const list = path.join(adir, "list.txt");
  fs.writeFileSync(list, parts.filter(p => fs.existsSync(p)).map(p =>
    `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  const r = await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", list,
    "-af", "apad", "-t", (totalMs / 1000).toFixed(3),
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", wav]);
  return r.code === 0 && fs.existsSync(wav) ? wav : null;
}

/** 测一个音频的平均电平，算出「升到 target dBFS 需要的增益」 */
async function rmsGain(file, targetDb){
  if (!file || !fs.existsSync(file)) return 0;
  const r = await run(BIN.ffmpeg, ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { timeout: 60000 });
  const m = String(r.err || "").match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  if (!m) return 0;
  return +(targetDb - parseFloat(m[1])).toFixed(2);
}

async function hasBlack(file){
  const r = await run(BIN.ffmpeg, ["-hide_banner", "-i", file,
    "-vf", "blackdetect=d=0.2:pix_th=0.10", "-f", "null", "-"], { timeout: 120000 });
  return /blackdetect/.test(String(r.err || ""));
}

async function hasFreeze(file){
  const r = await run(BIN.ffmpeg, ["-hide_banner", "-i", file,
    "-vf", "freezedetect=n=-60dB:d=0.8", "-f", "null", "-"], { timeout: 120000 });
  return /freeze_(start|duration)/.test(String(r.err || ""));
}

async function measureLoudness(file){
  const r = await run(BIN.ffmpeg, ["-hide_banner", "-i", file,
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=9:print_format=json", "-f", "null", "-"], { timeout: 120000 });
  const m = String(r.err || "").match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return { I: +j.input_i, TP: +j.input_tp, LRA: +j.input_lra };
  } catch(e){ return null; }
}

/**
 * 参考视频的纯伴奏，带缓存。
 *
 * 同一个参考视频只分离一次：按「路径 + 大小 + 修改时间」做 key。
 * 缓存转成 m4a —— 一分钟的 44.1k 立体声 wav 就是 10MB，缓存几十条能把盘吃满。
 */
async function refVideoBgm(refVideo, runDir, log){
  const cacheDir = path.join(runDir, "..", "..", "cache", "refbgm");
  fs.mkdirSync(cacheDir, { recursive: true });

  let st = null;
  try { st = fs.statSync(refVideo.path); } catch(e){}
  const key = st
    ? crypto.createHash("sha1")
      .update(`${refVideo.path}|${st.size}|${Math.round(st.mtimeMs)}`)
      .digest("hex").slice(0, 16)
    : "";
  const cached = key ? path.join(cacheDir, key + ".m4a") : "";
  if (cached && fs.existsSync(cached) && fs.statSync(cached).size > 20000){
    log(`BGM：用之前分离好的参考伴奏（缓存 ${key}）`);
    return cached;
  }

  const t0 = Date.now();
  const wav = await separateBgm(refVideo.path, runDir, log);
  const secs = ((await probe(wav))?.duration || 0).toFixed(1);
  if (!cached) return wav;
  const r = await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error",
    "-i", wav, "-c:a", "aac", "-b:a", "160k", "-ar", "48000", cached], { cwd: runDir });
  if (r.code !== 0 || !fs.existsSync(cached)){
    log("BGM：伴奏存档失败，本次直接用 wav");
    return wav;
  }
  log(`BGM：参考视频的纯伴奏已分离（${secs}s，人声已剔除，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  return cached;
}

function pickBgm(cfg, runDir){
  const cand = cfg.bgm && String(cfg.bgm).trim();
  if (cand && fs.existsSync(cand)) return cand;
  const local = path.join(runDir, "..", "..", "bgm");
  if (fs.existsSync(local) && fs.statSync(local).isDirectory()){
    const f = fs.readdirSync(local).filter(n => /\.(mp3|m4a|wav|aac)$/i.test(n))[0];
    if (f) return path.join(local, f);
  }
  return null;
}

/* ---------------- 封面 ---------------- */
async function makeCover(runDir, shotFiles, title, out, font){
  if (!shotFiles.length || !title) return "无标题";
  const src = shotFiles[0];
  const assFile = path.join(runDir, "cover.ass");

  const clean = String(title).replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  const rows = [];
  for (let i = 0; i < chars.length; i += 9) rows.push(chars.slice(i, i + 9).join(""));
  const LEAD = "·・,，。、|:：;；-—~";
  for (let i = 1; i < rows.length; i++){
    while (rows[i] && LEAD.includes(rows[i][0])){
      rows[i - 1] += rows[i][0];
      rows[i] = rows[i].slice(1);
    }
    if (!rows[i]) rows.splice(i--, 1);
  }
  const shown = rows.map(r => r.trim()).filter(Boolean).slice(0, 3);
  if (shown.length === 3 && rows.length > 3) shown[2] = shown[2].slice(0, 8) + "…";

  const LINE_H = 104, START_Y = 560;
  let y = START_Y;
  const bandTop = START_Y - 84;
  const bandBottom = START_Y + shown.length * LINE_H + 60;
  const events = [
    `Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{\\an7\\pos(0,${bandTop})\\p1\\bord0\\shad0\\1a&H70&\\1c&H000000&}m 0 0 l ${OUT_W} 0 ${OUT_W} ${bandBottom - bandTop} 0 ${bandBottom - bandTop}{\\p0}`
  ];
  for (const rw of shown){
    events.push(`Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{\\an5\\pos(540,${y})\\fs80\\b1}${rw}`);
    y += LINE_H;
  }
  y += 36;
  events.push(`Dialogue: 0,0:00:00.00,0:00:05.00,T,,0,0,0,,{\\an5\\pos(540,${y})\\fs38\\b0\\c&H00E0E0E0&}AI 自动混剪 · 竖版成片`);

  fs.writeFileSync(assFile, `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUT_W}
PlayResY: ${OUT_H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,${font},80,&H00FFFFFF,&H00FFFFFF,&H00202020,&H8C000000,-1,0,0,0,100,100,0,0,1,6,3,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`, "utf8");

  for (const ss of ["0.5", "0"]){
    const r = await run(BIN.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error",
      "-ss", ss, "-i", src, "-vf", "ass=cover.ass", "-frames:v", "1", "-update", "1", "-q:v", "3", out], { cwd: runDir });
    if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1000) return null;
  }
  return "取帧失败";
}

const lastErr = e => String(e || "").split("\n").map(s => s.trim()).filter(Boolean).pop() || "未知错误";
