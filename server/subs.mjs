/**
 * 字幕排版 —— ASS 生成、断行、关键词高亮。
 *
 * 断行是这里最要紧的一件事。中文没有空格，按字数硬切必然劈词，
 * 实测被劈过：「不仅回|收率」「一年少赚的钱都|够再添」。做法和 skill 一致：
 *   1. 12 字以内不断
 *   2. 断点候选 = 标点之后（优先）+ 词与词的缝隙
 *   3. 断点前一个字如果是单字虚词（都/就/还/也/才/会/又/再/不/没…）扣分，避免「都|够」
 *   4. 实在没有候选才退回中点
 * 这里没有 jieba，用「虚词 + 标点 + 数字/字母边界」做近似，效果接近。
 */

const PUNCT = "，。！？；：、,.!?;:…—";
const FUNC = "都就还也才会又再不没的了着过和跟把被将让使是在有与及或而但却很太更最能要";
const STOP_AUX = "的地得";

/**
 * 高频双字词表：切点落在词中间（矿|石、生|产线）比切歪一点难看得多，直接重罚。
 * 词表不用大，盖住口语里最常见的词就行；没有 jieba，这是近似。
 */
const LEXICON = (
  "矿石 矿物 脉石 矿山 选矿 分选 干选 湿选 浮选 磨矿 抛废 尾矿 废石 精矿 原矿 品位 回收 " +
  "富集 破碎 入磨 石英 萤石 金矿 银矿 铜矿 铁矿 铅锌 煤炭 块煤 精煤 选厂 车间 生产线 " +
  "识别 设备 机器 成本 处理 环保 回收率 效果 质量 系统 服务 价格 市场 产品 企业 公司 " +
  "项目 技术 数据 能耗 电费 药费 负担 优势 传统 智能 检测 分析 提升 下降 增加 减少 " +
  "提高 节约 浪费 排放 污染 达标 政策 标准 我们 你们 他们 大家 现在 以后 开始 完成 " +
  "选择 使用 操作 简单 方便 快速 稳定 运行 工作 时间 效率 产能 产量 收益 利润 投资 " +
  "合作 支持 保障 售后 安装 调试 培训 现场 远程 在线 实时 精准 高效 自动 人工 试验 报告"
).split(/\s+/);

const BAD_PAIRS = new Set();
for (const w of LEXICON){
  const cs = [...w];
  for (let k = 0; k + 1 < cs.length; k++) BAD_PAIRS.add(cs[k] + cs[k + 1]);
}

/** 强标点 = 一句话的尽头；弱标点 = 句内的气口 */
const STRONG = "。！？；!?;";
const WEAK = "，、,:：—…";

/**
 * 整段文案切成「一句一条字幕」的短句。
 * 参考视频（抖音口播）的节奏就是 5~8 字一屏、单行居中，绝不整段糊屏。
 * 用户把整段文案粘成一个格子时，靠这里兜底切开。
 * @param max 单条目标字数上限（超出才继续往下切）
 */
export function splitScript(lines, max = 14){
  return splitScriptEx(lines, max).map(x => x.text);
}

/**
 * 同 splitScript，但每条都带 owner（它来自用户输入的第几行）。
 *
 * 为什么要这个：字幕是 ≤14 字一屏的「屏幕节奏」，镜头是「一句话一个」，两者不是一回事。
 * 拿字幕短句去切镜头，一句话会被劈成 2–3 个镜头，看起来就是「一直在切」。
 * 分镜要按 owner 归回原句再切。
 */
export function splitScriptEx(lines, max = 14){
  const out = [];                       // [{text, owner}]
  let owner = 0;
  for (const raw of lines){
    const s = String(raw || "").replace(/\s+/g, " ").trim();
    if (!s){ owner++; continue; }
    if ([...s].length <= max){ out.push({ text: s, owner: owner++ }); continue; }

    // 1) 强标点切句
    const sents = [];
    let buf = "";
    for (const ch of [...s]){
      buf += ch;
      if (STRONG.includes(ch)){ sents.push(buf); buf = ""; }
    }
    if (buf) sents.push(buf);

    // 2) 超长的句子再按弱标点切气口
    const parts = [];
    for (const p of sents){
      if ([...p].length <= max){ parts.push(p); continue; }
      let sub = "";
      for (const ch of [...p]){
        sub += ch;
        // 气口太早切会把「X射线」「85%」这种词劈一半，至少攒到一半长再切
        if (WEAK.includes(ch) && [...sub].length >= Math.floor(max * 0.55)){
          parts.push(sub); sub = "";
        }
      }
      if (sub) parts.push(sub);
    }

    // 2.5) 弱标点救不了的（一整句只有句尾一个逗号），按词缝硬切
    const parts2 = [];
    for (const p of parts){
      if ([...p].length <= max){ parts2.push(p); continue; }
      let rest = p;
      while ([...rest].length > max){
        const cut = bestBreak(rest, max);
        parts2.push([...rest].slice(0, cut).join(""));
        rest = [...rest].slice(cut).join("");
      }
      if (rest) parts2.push(rest);
    }

    // 3) 碎句（不足 4 字）并给前一条，别让「啊」「对」单独占一屏
    for (const p of parts2){
      if ([...p].length < 4 && out.length) out[out.length - 1].text += p;
      else out.push({ text: p, owner });
    }
    owner++;
  }
  return out;
}

/** 展示用：去掉句尾的逗号顿号句号（参考视频的字幕不带尾标点），感叹问号保留 */
function stripTail(s){
  return String(s || "").replace(/[，、。,]$/u, "").trim();
}

/** 关键词：数字带单位、百分比、倍数、型号缩写。单位按「长的在前」排，避免 度电 被拆成 度 + 电 */
export const KEYWORD_RE = /(\d+(?:\.\d+)?(?:%|％|度电|小时|分钟|毫米|厘米|公分|个点|倍|吨|台|套|成|万|亿)|\d+(?:\.\d+)?[-–~～]\d+(?:\.\d+)?倍?|[A-Z]{2,5}(?:\s?\d+)?)/g;

/**
 * 断行：返回行数组。
 * @param text 一行字幕原文
 * @param max  单行最多多少字（超过就断）
 */
export function wrapLines(text, max = 12){
  const s = String(text || "").trim();
  if (!s) return [];
  if ([...s].length <= max) return [s];

  const chars = [...s];
  // 太长先按标点粗分，标点后天然是气口
  const chunks = [];
  let cur = "";
  for (const ch of chars){
    cur += ch;
    if (PUNCT.includes(ch)){ chunks.push(cur); cur = ""; }
  }
  if (cur) chunks.push(cur);

  const lines = [];
  let line = "";
  for (const ck of chunks){
    if ([...line + ck].length <= max){ line += ck; continue; }
    if (line) { lines.push(line); line = ""; }
    if ([...ck].length <= max){ line = ck; continue; }
    // 单块本身就超长：找最像词缝的地方切
    let rest = ck;
    while ([...rest].length > max){
      const cut = bestBreak(rest, max);
      lines.push([...rest].slice(0, cut).join(""));
      rest = [...rest].slice(cut).join("");
    }
    line = rest;
  }
  if (line) lines.push(line);

  // 单条不超过 3 行：超了就把最后两行并起来（宁可挤一点，也不要第四行压到画面）
  if (lines.length > 3){
    const head = lines.slice(0, 2);
    head.push(lines.slice(2).join(""));
    return head;
  }
  return lines;
}

/** 在 [max*0.4, max] 里挑一个最不像"劈开词"的位置 */
function bestBreak(s, max){
  const chars = [...s];
  const lo = Math.max(3, Math.floor(max * 0.35));
  // 给句尾留至少 4 个字：切出「了！」这种 2 字尾巴会被碎句合并拼回去，等于没切
  const hi = Math.max(lo, Math.min(max, chars.length - 4));
  let best = hi, bestScore = -Infinity;
  for (let i = lo; i <= hi; i++){
    let score = 0;
    const prev = chars[i - 1], next = chars[i];
    if (PUNCT.includes(prev)) score += 6;          // 标点后是新句，最优先
    if ("、，,：:".includes(prev)) score += 2;
    if (STOP_AUX.includes(prev)) score += 5;       // 「……的钱 | 都够」这种最自然
    else if (FUNC.includes(prev)) score -= 4;      // 「都|够」这种最难看
    if (FUNC.includes(next)) score -= 2;
    if (BAD_PAIRS.has(prev + next)) score -= 6;    // 词中间不落刀：矿|石、生|产线
    if (/[0-9A-Za-z]/.test(prev) !== /[0-9A-Za-z]/.test(next)) score += 1.5; // 数字/字母边界
    // 越靠后越好，别把第一行切得太短
    score += (i / hi) * 2;
    if (score > bestScore){ bestScore = score; best = i; }
  }
  return Math.max(1, best);
}

/** 把关键词套上「划重点」：亮黄 + 暖描边 + 出现时弹一下停住 */
export function highlight(text, size = 78){
  // 变色是核心（亮黄 &H0000E8FF，BGR），再配一层暖描边让它在暗底上跳出来；
  // \fscx 弹一下停在 112%：不动字号，所以不会挤行距，只是「顿一下」的重点感。
  const kw = `{\\c&H0000E8FF&\\3c&H002060E8&\\bord9\\fscx100\\fscy100`
    + `\\t(0,110,\\fscx118\\fscy118)\\t(110,230,\\fscx112\\fscy112)}`;
  return String(text)
    .replace(/[{}]/g, "")
    .replace(KEYWORD_RE, m => `${kw}${m}{\\r}`);
}

/** 纯文本（给声波层用：只留描边，不能带颜色标签） */
const plain = s => String(s || "").replace(/[{}]/g, "").replace(/\\N/g, " ");

const assTime = ms => {
  const t = Math.max(0, ms) / 1000;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};

const esc = s => String(s || "").replace(/\r?\n/g, " ").replace(/[{}]/g, "");

/**
 * 生成字幕层。样式对齐参考视频：白色粗体 + 深色粗描边 + 无底色块，
 * 单行短句，位置在画面中部偏下（约 57% 高度处）。
 * @param cues [{start,end,text}]
 * @param opt  {font,size,marginV}
 */
export function buildAss(cues, opt = {}){
  const font = opt.font || "Microsoft YaHei";
  const size = opt.size || 78;
  // an2 底部对齐：marginV 是「字幕底边到画面底边」的距离。
  // 要求落点 y = h - 660（1920 高 → 1260，约 66% 高度，中间偏下、视线自然落点）。
  // marginV 直接就是 h-660 的那个 660，单位是 ASS 的脚本像素（PlayResY=1920）。
  const marginV = opt.marginV ?? 660;
  const maxChars = opt.maxChars || 14;
  const intro = opt.intro !== false;      // 开场呐喊（只做第一屏）
  const kwFx = opt.kw !== false;          // 关键词划重点

  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Def,${font},${size},&H00FFFFFF,&H00FFFFFF,&H000F0F0F,&H8C000000,-1,0,0,0,100,100,1,0,1,6,0,2,60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const rows = [];
  cues.forEach((c, i) => {
    // 一句一屏：一行文案就是一条字幕，不合并、不折行。
    // 宽度按实际像素算：1080 - 左右各 60 边距 = 960。
    // 放不下时优先把这一条的字号缩一点（不低于 78%），缩到底还放不下才折行。
    // 原来开场写死 8 字，11 个字的第一句被硬断成两行，跟「一行一句话」对不上。
    const isIntro = intro && i === 0;
    const raw = stripTail(c.text);
    const fitFs = (chars, scale) => Math.floor((1080 - 120) / Math.max(1, chars * scale));
    const minFs = Math.round(size * 0.78);
    let useFs = Math.min(size, fitFs(raw.length, 1));
    if (isIntro) useFs = Math.min(useFs, fitFs(raw.length, 1.24));
    const oneLine = useFs >= minFs;
    const lines = oneLine ? [raw] : wrapLines(raw, Math.max(4, Math.min(maxChars, Math.floor((1080 - 120) / minFs))));
    if (!lines.length) return;
    const fsFix = oneLine && useFs < size ? `\\fs${useFs}` : "";

    const paint = kwFx ? l => highlight(l, size) : l => esc(l);

    // 声波环先写：同 layer 下后写的盖前面的，让字幕压在声波上面
    if (isIntro) rows.push(...waveRows(c, lines[0]));

    const body = lines.map(paint).join("\\N");
    // 开场：124% 砸下来 → 100%，模糊同时收干净，再余震两次（喊完的回音）。
    // 时长按帧算过：170ms ≈ 5 帧，肉眼才看得出「缩」；90ms 只有 2.7 帧，等于没动。
    // 其余：淡入淡出 + 1.05 收到 1.00，不弹跳
    const fx = isIntro
      ? `{${fsFix}\\fad(40,40)\\fscx124\\fscy124\\blur5\\t(0,170,\\fscx100\\fscy100\\blur0)`
        + `\\t(170,300,\\fscx107\\fscy107)\\t(300,440,\\fscx100\\fscy100)}`
      : `{${fsFix}\\fad(45,45)\\fscx105\\fscy105\\t(0,300,\\fscx100\\fscy100)}`;
    rows.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Def,,0,0,0,,${fx}${body}`);
  });
  return head + rows.join("\n") + "\n";
}

/**
 * 声波环：拿第一行文字只留描边，向外扩散两层并淡出。
 * 不是真波形（ASS 画不了），但字形轮廓放大 + 描边淡出，视觉上就是「喊出声」那一圈。
 * 关键在「细 + 淡」：描边一粗、起始一实，就变成重影而不是波纹。
 */
function waveRows(cue, line){
  const text = plain(line);
  if (!text) return [];
  const out = [];
  // 层层更细更淡、更晚出发、扩得更大
  // 不透明度取了中间值：全实=&H00& 会像重影，太淡=&H55& 又看不见
  const rings = [
    { delay: 0,   from: 112, to: 178, bord: 3, a: "30", dur: 430 },
    { delay: 130, from: 106, to: 205, bord: 4, a: "70", dur: 450 }
  ];
  for (const r of rings){
    const t0 = cue.start + r.delay;
    const dur = Math.min(r.dur, Math.max(220, cue.end + 200 - t0));
    const fx = `{\\1a&HFF&\\3a&H${r.a}&\\bord${r.bord}\\fscx${r.from}\\fscy${r.from}`
      + `\\t(0,${dur},1.4,\\fscx${r.to}\\fscy${r.to}\\3a&HFF&)}`;
    out.push(`Dialogue: 0,${assTime(t0)},${assTime(t0 + dur)},Def,,0,0,0,,${fx}${text}`);
  }
  return out;
}

/** 给用户下载的 srt，保持整句，不折行 */
export function buildSrt(cues){
  const t = ms => {
    const v = Math.max(0, ms);
    const h = Math.floor(v / 3600000), m = Math.floor(v % 3600000 / 60000);
    const s = Math.floor(v % 60000 / 1000), ms3 = Math.round(v % 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms3).padStart(3, "0")}`;
  };
  return cues.map((c, i) => `${i + 1}\n${t(c.start)} --> ${t(c.end)}\n${esc(c.text)}\n`).join("\n");
}
