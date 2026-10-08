// Translates page fragments (paragraphs, list items, cells...) for in-place replacement.
//
// Neighbouring fragments travel together, one blank line between them, so a long
// selection costs a few requests and the service sees each paragraph in context.
// If a service merges or splits paragraphs and the count no longer matches, that
// batch is translated again one fragment at a time.
import { mapLimit } from './chunk.js';

export const BATCH_CHARS = 3000;
const SEP = '\n\n';
const BLANK_LINE = /\n[^\S\n]*\n/;

/** Groups fragment indexes into batches of at most `max` characters (with separators). */
export function batchSegments(texts, max = BATCH_CHARS) {
  const batches = [];
  let cur = null;
  let size = 0;
  texts.forEach((text, i) => {
    // A fragment that has blank lines of its own (preformatted text) cannot share a request.
    const alone = BLANK_LINE.test(text);
    if (cur && !alone && !cur.alone && size + SEP.length + text.length <= max) {
      cur.items.push(i);
      size += SEP.length + text.length;
      return;
    }
    cur = { items: [i], alone };
    size = text.length;
    batches.push(cur);
  });
  return batches.map((b) => b.items);
}

/**
 * @param {string[]} texts  fragments, in page order
 * @param {(text: string) => Promise<string>} translateOne
 * @returns {Promise<string[]>} translations, one per fragment
 */
export async function translateSegments(texts, translateOne, { max = BATCH_CHARS, limit = 2 } = {}) {
  const results = new Array(texts.length);
  await mapLimit(batchSegments(texts, max), limit, async (items) => {
    if (items.length > 1) {
      const out = await translateOne(items.map((i) => texts[i]).join(SEP));
      const parts = String(out).split(BLANK_LINE).map((s) => s.trim()).filter(Boolean);
      if (parts.length === items.length) {
        items.forEach((i, k) => { results[i] = parts[k]; });
        return;
      }
    }
    const singles = await mapLimit(items, limit, (i) => translateOne(texts[i]));
    items.forEach((i, k) => { results[i] = String(singles[k]).trim(); });
  });
  return results;
}
