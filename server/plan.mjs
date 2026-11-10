/**
 * 分镜规划 —— 自动版的 plan.json。
 *
 * 人工剪片时这一步是「看联系表、决定每个镜头用哪条素材、什么运镜」，最值钱也最费人。
 * 这里把它规则化，规则与口播片的剪法一致：
 *
 *   1. 一句一镜：一句话一个镜头，切点落在句界上 —— 句界就是配音换气的地方（气口），
 *      所以切点天然不会切在半截音里，也不会把一句话劈成两个画面。
 *   2. 短句并镜：单句不足 1.6s 时并入后面的句子，最多 3 句 / 3.4s。
 *      短句独立成镜会「赶」，两句一个镜头才顺。
 *   3. 长句才补刀：单句超过 6s，在逗号处补一刀（逗号也是气口）。其余一律不切。
 *   4. 时长以配音为准：不凑时长、不压缩、不为了对齐硬吞字尾。
 *   5. 镜头切换速度由文案决定：句子长镜头就长，句子短镜头就短，不做平均值强行拉平。
 *   6. 素材按你选的顺序依次对应镜头 —— 没有视觉判断能力，顺序是唯一能让画面贴合
 *      文案的抓手（你挑素材时的顺序就是你的意图）。
 *   7. 同一素材不连续出现；复用时换取景，并收窄推拉幅度，避免近景被裁残。
 */

export const TARGET_SHOT = 2200;   // 参考值，仅在没给出逐句时间时用于兜底
export const MIN_SHOT = 1600;      // 短于此就并镜，单句独立成镜会「赶」
export const MAX_SHOT = 3000;      // 仅用于展示统计
export const MAX_PER_CLIP = 4;     // 非顺序模式时同一素材最多用几次

const MERGE_MAX = 3400;            // 短句并镜后的理想上限
const MERGE_HARD = 4400;           // 硬上限：为消掉 0.7s 碎镜，宁可略长一点
const MAX_MERGE_SENTENCES = 3;     // 最多并三句

/**
 * 「换画面」那三个档位真正落地的地方（UI：一句一镜 / 标准 / 多切）。
 *   single —— 严格一句一镜，长句也不补刀（切点只在句界）
 *   std    —— 一句一镜，只有 6.2s 以上的长句才在逗号处补刀
 *   multi  —— 3.6s 以上就补刀，一段话会被切成更多镜头
 */
const MODES = {
  // exact —— 严格「一行文案一个镜头」，短句也不并、碎镜也不吸收、长句也不补刀。
  //          用户明确要求「一行就是一句，一句断一次」，画面对不上文案的代价，
  //          比 1 秒的碎镜更难接受，所以这档不做任何合并。
  exact:  { strict: true,  longSentence: Infinity, longChunk: Infinity },
  single: { longSentence: Infinity, longChunk: Infinity },
  std:    { longSentence: 6200,     longChunk: 3600 },
  multi:  { longSentence: 3600,     longChunk: 2800 }
};

/**
 * @param items     [{i,text,t0,t1}] 逐句时间（来自整段配音，句界即气口）
 * @param mats      [{file,isImg,duration,width,height}] 可用素材（按用户选择顺序）
 * @param totalMs   配音总时长（含片头片尾留白）
 * @param charTimes 字格起点（长句补刀时用）
 */
export function planShots(items, mats, totalMs, charTimes = [], opt = {}){
  const minShot = Number(opt.minShot) || MIN_SHOT;
  const mode = MODES[String(opt.shotsMode || "std")] || MODES.std;
  const list = Array.isArray(items) ? items.filter(it => it && it.t1 > it.t0) : [];
  if (!list.length) return [];

  /* ---------- 1. 一句一镜 + 短句并镜（切点只落在句界上） ---------- */
  const shots = [];
  let i = 0;
  while (i < list.length){
    const group = [list[i]];
    let span = list[i].t1 - list[i].t0;
    // 短句往后并：并进的句子必须还在气口上，且总长不超硬上限
    // 短句往后并：strict 档（严格一行一镜）不并，其他档并进的句子必须还在气口上
    while (!mode.strict && span < minShot && i + group.length < list.length && group.length < MAX_MERGE_SENTENCES){
      const next = list[i + group.length];
      const merged = next.t1 - group[0].t0;
      if (merged > MERGE_HARD) break;
      group.push(next);
      span = merged;
    }
    shots.push({
      phrases: group.map(x => x.i),
      text: group.map(x => x.text || "").join(""),
      t0: group[0].t0,
      t1: group[group.length - 1].t1
    });
    i += group.length;
  }

  // 兜底：并完还不够 1.6s 的碎镜，往更短的一侧并（并后不超硬上限）。
  // 0.7s 的孤镜比 3.8s 的长镜难看得多 —— 观众的注意力还没落下就切走了。
  // strict 档例外：一行就是一镜，1 秒也单独出镜，不然又跟文案对不上。
  if (!mode.strict) absorbFragments(shots, minShot);

  /* ---------- 2. 长句补刀：只在逗号处，补到每段都在上限内 ---------- */
  const split = [];
  for (const s of shots){
    if (s.t1 - s.t0 <= mode.longSentence){ split.push(s); continue; }
    split.push(...splitAtComma(s, charTimes, 0, mode.longChunk));
  }
  shots.length = 0;
  shots.push(...split);

  /* ---------- 3. 收尾：末镜盖到片尾 ---------- */
  // 末镜的 t1 是「片子结束」，不是切点：它只负责让画面一直有东西，
  // 片尾那 0.75s 留白靠这一镜的画面延续，所以不参与「切点是否落在气口」的判定。
  const speechEnd = Math.round(list[list.length - 1].t1);
  const last = shots[shots.length - 1];
  last.t1 = Math.max(last.t1, speechEnd, Math.round(totalMs || 0));


  /* ---------- 4. 配素材：默认按选择顺序对应镜头 ---------- */
  // 顺序模式：第 n 镜用第 n 条素材。没有视觉能力，这是唯一能贴合文案顺序的抓手。
  // 素材少于镜头时按循环走，并保证不连续重复。
  const seq = opt.seqMats !== false && mats.length >= 3;
  const used = new Map();
  let lastIdx = -1;

  shots.forEach((s, n) => {
    let idx;
    if (seq){
      idx = n % mats.length;
      if (mats.length > 1 && idx === lastIdx) idx = (idx + 1) % mats.length;
    } else {
      idx = pickMat(mats, used, lastIdx, n).idx;
    }
    const m = mats[idx];
    used.set(idx, (used.get(idx) || 0) + 1);
    lastIdx = idx;

    const dur = (s.t1 - s.t0) / 1000;
    s.idx = n;
    s.clip = m.file;
    s.isImg = m.isImg;
    s.matDur = m.duration || 0;
    s.w = m.w || 0;
    s.h = m.h || 0;
    // 同一条素材再次出现就换取景，别让人看出「怎么又是这个画面」
    const reuse = used.get(idx) - 1;
    s.fx = reuse ? (reuse % 2 ? 0.34 : 0.66) : 0.5;
    s.fy = 0.5;
    s.in = pickIn(m, dur, reuse);
    s.note = `${reuse ? "复用" : "首用"}·第 ${used.get(idx)} 次`;
  });

  /* ---------- 5. 运镜：禁止连续相同，末镜缓拉 ---------- */
  const ROTATE = ["in", "panlr", "in", "out", "panrl", "in", "tiltu", "in"];
  shots.forEach((s, n) => {
    if (n === shots.length - 1){ s.move = "out"; return; }
    if (n === 0){ s.move = "panlr"; return; }
    let mv = ROTATE[n % ROTATE.length];
    if (mv === shots[n - 1].move) mv = shots[n - 1].move === "in" ? (n % 2 ? "panlr" : "out") : "in";
    s.move = mv;
  });

  return shots;
}

/**
 * 碎镜吸收：「一句一镜」在长文案里最顺，但短句连发时会剩下一个 0.7s 的孤镜。
 * 这里把不足 minShot 的镜头并到更短的一侧（并后不超 MERGE_HARD），切点仍然只落在句界。
 */
function absorbFragments(shots, minShot){
  let guard = 0;
  for (let k = 0; k < shots.length && guard++ < 200; k++){
    const s = shots[k];
    if (s.t1 - s.t0 >= minShot) continue;
    if (shots.length === 1) break;

    const prev = k > 0 ? shots[k - 1] : null;
    const next = k + 1 < shots.length ? shots[k + 1] : null;
    const cand = [];
    if (prev){
      const d = s.t1 - prev.t0;
      if (d <= MERGE_HARD) cand.push({ side: "prev", d });
    }
    if (next){
      const d = next.t1 - s.t0;
      if (d <= MERGE_HARD) cand.push({ side: "next", d });
    }
    if (!cand.length) continue;                 // 两边并了都超硬上限，就让它独自短着
    cand.sort((a, b) => a.d - b.d);

    if (cand[0].side === "prev"){
      prev.t1 = s.t1;
      prev.phrases = [...prev.phrases, ...s.phrases];
      prev.text = (prev.text || "") + (s.text || "");
      shots.splice(k, 1);
    } else {
      s.t1 = next.t1;
      s.phrases = [...s.phrases, ...next.phrases];
      s.text = (s.text || "") + (next.text || "");
      shots.splice(k + 1, 1);
    }
    k--;                                        // 并完这一镜可能反而超上限，回头再看一眼
  }
}

/**
 * 长句在逗号处补刀。逗号是气口，切在这里不破坏语流。
 * 补完哪段还超 LONG_CHUNK 就再补一刀（递归），直到每段都在区间里；
 * 没有可用逗号（或切下去会出现短于 minShot 的段）就原样返回，宁可一个长镜也不切碎。
 */
function splitAtComma(shot, charTimes, depth = 0, chunk = 3600){
  const text = String(shot.text || "");
  const dur = shot.t1 - shot.t0;
  if (depth >= 3 || dur <= chunk) return [shot];

  const cuts = [];
  for (let k = 0; k < text.length; k++){
    if (/[，、；,;]/.test(text[k])) cuts.push(k);
  }
  if (!cuts.length) return [shot];

  // 候选切点：左边右边都不短于 minShot 才允许下刀
  const ok = [];
  for (const k of cuts){
    const t = shot.t0 + ((k + 1) / Math.max(1, text.length)) * dur;
    if (t - shot.t0 >= minShotOf() && shot.t1 - t >= minShotOf()) ok.push({ k, t });
  }
  if (!ok.length) return [shot];

  // 取最接近中点的那个逗号，切完两段长度最接近
  const mid = shot.t0 + dur / 2;
  const best = ok.reduce((a, b) => Math.abs(b.t - mid) < Math.abs(a.t - mid) ? b : a);

  let t = Math.round(best.t);
  // 有字格就吸到字的起点，别切在半截音里
  const snapped = snap(t, charTimes, shot.t0, shot.t1, []);
  if (Math.abs(snapped - t) <= 260) t = snapped;

  const head = { ...shot, text: text.slice(0, best.k + 1), t1: t };
  const tail = { ...shot, text: text.slice(best.k + 1), t0: t };
  return [
    ...splitAtComma(head, charTimes, depth + 1, chunk),
    ...splitAtComma(tail, charTimes, depth + 1, chunk)
  ];
}

/** 补刀时的最小段长：留一点余量，别切出 1.4s 的碎段 */
function minShotOf(){ return MIN_SHOT * 0.9; }


/**
 * 切点吸附：优先往最近的字符起点靠（±220ms），没有字可吸时退到参考视频的说话点（±600ms）。
 * 两头各留 340ms 余量。
 */
function snap(t, charTimes, lo, hi, anchors){
  const inRange = v => v > lo + 340 && v < hi;
  let best = null, bd = 220;
  for (const ct of charTimes || []){
    const d = Math.abs(ct - t);
    if (d < bd){ bd = d; best = ct; }
  }
  // 字上没得吸 → 吸参考视频的说话起点（卡参考的节奏）
  if (best === null && anchors && anchors.length){
    let ba = 600;
    for (const a of anchors){
      const d = Math.abs(a - t);
      if (d < ba){ ba = d; best = a; }
    }
  }
  if (best === null) return Math.round(t);
  if (!inRange(best)) return Math.round(t);
  return Math.round(best);
}

/**
 * 选素材（非顺序模式）：优先用得最少的，避开上一镜用过的那条。
 * 素材不够多的时候必然要复用，这时靠 fx/fy/move 错开取景，而不是硬塞新镜头。
 */
function pickMat(mats, used, lastIdx, i){
  let best = -1, bestScore = Infinity;
  for (let k = 0; k < mats.length; k++){
    const n = used.get(k) || 0;
    if (n >= MAX_PER_CLIP) continue;
    if (mats.length > 1 && k === lastIdx) continue;
    // 用得少优先；同分时按轮转错开，避免总从第一条开始
    const score = n * 1000 + ((k - i + mats.length * 2) % mats.length);
    if (score < bestScore){ bestScore = score; best = k; }
  }
  if (best < 0){
    // 全片都用满了 4 次，或者只剩一条素材：退而求其次，允许相邻复用
    let least = Infinity;
    for (let k = 0; k < mats.length; k++){
      const n = used.get(k) || 0;
      if (mats.length > 1 && k === lastIdx) continue;
      if (n < least){ least = n; best = k; }
    }
  }
  if (best < 0) best = 0;
  return { idx: best };
}

/** 入点：避开素材首尾（常有黑场、抖动、收尾空镜），复用时往后错开 */
function pickIn(m, shotDur, reuse){
  if (m.isImg || !m.duration) return 0;
  const room = Math.max(0, m.duration - shotDur - 0.2);
  if (room <= 0) return 0;
  const base = m.duration * 0.12 + reuse * Math.max(0.8, shotDur * 0.7);
  return +Math.min(room, Math.max(0, base)).toFixed(2);
}

/** 统计信息，写进任务日志给人看 */
export function planSummary(shots, totalMs){
  const n = shots.length;
  const durs = shots.map(s => s.t1 - s.t0);
  const avg = durs.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const min = Math.min(...durs), max = Math.max(...durs);
  const long = durs.filter(d => d >= 2500).length;
  const clips = new Set(shots.map(s => s.clip)).size;
  return {
    shots: n, avg: avg / 1000, min: min / 1000, max: max / 1000,
    long, clips, total: totalMs / 1000,
    text: `${n} 镜 · 平均 ${(avg / 1000).toFixed(2)}s · 最短 ${(min / 1000).toFixed(2)}s · 最长 ${(max / 1000).toFixed(2)}s · ${clips} 条素材`
  };
}
