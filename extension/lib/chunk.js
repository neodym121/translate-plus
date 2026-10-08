// Splits long text into pieces a translation endpoint accepts, and glues the
// translated pieces back together with the original line breaks.

// A sentence plus the whitespace that follows it (CJK sentences have none).
const SENTENCE = /[^.!?…。！？؟।]*(?:[.!?…。！？؟।]+["'”’)»\]]*\s*|$)/gu;

/**
 * Cuts one over-long line at sentence ends, then at spaces, then hard.
 * @returns {{text: string, trail: string}[]} pieces <= max and the whitespace that followed each.
 */
function splitLong(str, max) {
  const atoms = [];
  for (const unit of str.match(SENTENCE) ?? []) {
    if (!unit) continue;
    if (unit.trimEnd().length <= max) { atoms.push(unit); continue; }
    for (const word of unit.match(/\S+\s*/g) ?? []) {
      if (word.trimEnd().length <= max) { atoms.push(word); continue; }
      for (let i = 0; i < word.length; i += max) atoms.push(word.slice(i, i + max));
    }
  }

  const pieces = [];
  let cur = '';
  const flush = () => {
    if (!cur) return;
    const text = cur.trimEnd();
    pieces.push({ text, trail: cur.slice(text.length) });
    cur = '';
  };
  for (const atom of atoms) {
    if (cur && (cur + atom).trimEnd().length > max) flush();
    cur += atom;
  }
  flush();
  return pieces;
}

/**
 * @returns {{text: string, sepBefore: string}[]} chunks no longer than `max`.
 * `sepBefore` is the whitespace that stood between this chunk and the previous one.
 */
export function splitIntoChunks(text, max) {
  const pieces = [];
  let join = '';
  text.split(/(\n+)/).forEach((part, i) => {
    if (i % 2 === 1) { join += part; return; }
    if (!part.trim()) { join += part; return; }
    const segments = splitLong(part.trim(), max);
    segments.forEach((seg, j) => {
      pieces.push({ text: seg.text, joinBefore: j === 0 ? join : segments[j - 1].trail });
    });
    join = '';
  });

  const chunks = [];
  let cur = null;
  for (const p of pieces) {
    if (cur && cur.text.length + p.joinBefore.length + p.text.length <= max) {
      cur.text += p.joinBefore + p.text;
    } else {
      cur = { text: p.text, sepBefore: chunks.length ? p.joinBefore : '' };
      chunks.push(cur);
    }
  }
  return chunks;
}

export function joinChunks(chunks, translated) {
  return translated.map((t, i) => chunks[i].sepBefore + t).join('');
}

/** Runs `fn` over `items` with at most `limit` in flight; keeps result order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
