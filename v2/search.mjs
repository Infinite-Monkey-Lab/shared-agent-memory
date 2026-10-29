const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set(['我', '你', '的', '了', '吗', '什么', '怎么', '如何', '用', '看', '是', '有', '一个', '请', '查询', '记忆', 'the', 'a', 'is', 'what', 'my']);

export function terms(text, limit = Infinity) {
  const out = new Set();
  for (const part of segmenter.segment(text.normalize('NFKC').toLowerCase())) {
    if (!part.isWordLike || stop.has(part.segment)) continue;
    const word = part.segment;
    out.add(word);
    if (/^[\p{Script=Han}]+$/u.test(word) && [...word].length > 2) {
      const chars = [...word];
      for (let i = 0; i < chars.length - 1; i++) out.add(chars.slice(i, i + 2).join(''));
    }
  }
  return [...out].slice(0, limit);
}

export function bounded(items, limit, budget) {
  const selected = [];
  let used = 0;
  let truncated = items.length > limit;
  for (const item of items.slice(0, limit)) {
    const chars = [...item.content];
    const remaining = budget - used;
    if (remaining <= 0) { truncated = true; break; }
    const cut = chars.length > remaining;
    selected.push({ ...item, content: chars.slice(0, remaining).join(''), truncated: cut });
    used += Math.min(chars.length, remaining);
    truncated ||= cut;
  }
  return { items: selected, used_characters: used, truncated };
}
