/**
 * 给整条外部配音排字幕。音频可能只在几个段落之间停顿，不能把离当前句很远的
 * 停顿硬塞给每一句；先把少量真实停顿分配给最近的句界，再在段落内按字数铺开。
 */
export function alignVoiceCues(lines, durationMs, analysis = null){
  const texts = lines.map(s => String(s || ""));
  const n = texts.length;
  if (!n) return { items: [], alignedPauses: 0, mode: "empty" };

  const end = Math.max(1, Math.round(durationMs));
  const speech = analysis?.ok && analysis.hasSpeech && Array.isArray(analysis.speech) ? analysis.speech : [];
  const start = speech.length ? Math.max(0, Math.min(end - 1, Math.round(speech[0].s * 1000))) : 0;
  const stop = speech.length ? Math.max(start + 1, Math.min(end, Math.round(speech.at(-1).e * 1000))) : end;
  const weight = text => Math.max(1, [...text.replace(/\s/g, "")].filter(c => !/[，。！？；：、,.!?;:…—]/u.test(c)).length);
  const weights = texts.map(weight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const ideals = [start];
  let acc = 0;
  for (let i = 0; i < n; i++){
    acc += weights[i];
    ideals.push(start + (acc / totalWeight) * (stop - start));
  }

  const anchors = [{ index: 0, before: start, after: start }];
  const pauses = analysis?.ok && analysis.hasSpeech && Array.isArray(analysis.pauses) ? analysis.pauses : [];
  const tolerance = Math.min(1700, Math.max(500, ((stop - start) / n) * 1.5));
  const minCue = Math.min(120, (stop - start) / n * 0.25);
  for (const p of pauses){
    const before = Math.round(p.s * 1000), after = Math.round(p.e * 1000);
    if (after - before < 180 || before <= start || after >= stop) continue;
    const mid = (before + after) / 2;
    const last = anchors.at(-1);
    let bestIndex = -1, bestDistance = Infinity;
    for (let i = last.index + 1; i < n; i++){
      const distance = Math.abs(ideals[i] - mid);
      if (distance >= bestDistance || distance > tolerance) continue;
      if (before - last.after < (i - last.index) * minCue) continue;
      if (stop - after < (n - i) * minCue) continue;
      bestIndex = i; bestDistance = distance;
    }
    if (bestIndex > 0) anchors.push({ index: bestIndex, before, after });
  }
  anchors.push({ index: n, before: stop, after: stop });

  const items = new Array(n);
  for (let block = 0; block < anchors.length - 1; block++){
    const left = anchors[block], right = anchors[block + 1];
    const blockStart = left.after, blockEnd = right.before;
    const blockWeight = weights.slice(left.index, right.index).reduce((a, b) => a + b, 0);
    let elapsedWeight = 0;
    for (let i = left.index; i < right.index; i++){
      const t0 = Math.round(blockStart + (elapsedWeight / blockWeight) * (blockEnd - blockStart));
      elapsedWeight += weights[i];
      const t1 = i === right.index - 1 ? blockEnd
        : Math.round(blockStart + (elapsedWeight / blockWeight) * (blockEnd - blockStart));
      items[i] = { i, text: texts[i], t0, t1 };
    }
  }
  return { items, alignedPauses: anchors.length - 2, mode: anchors.length > 2 ? "pauses+text" : "text" };
}
