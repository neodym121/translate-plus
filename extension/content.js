// Shows the Translate+ logo at the end of selected text. A click sends the text
// to the background worker, which opens the translator window. A Shift+click
// translates the selection and puts the translation where the original was.
(() => {
  'use strict';
  if (window.__translatePlusLoaded) return;
  window.__translatePlusLoaded = true;

  const SIZE = 22;      // icon size, px
  const GAP = 4;        // distance from the end of the selection
  const EDGE = 6;       // minimum distance from the viewport edge
  const IN_PLACE_MAX = 20000;  // characters a Shift+click translates at once
  const UNDO_LIMIT = 20;       // in-place translations Ctrl+Z can take back
  const HIGHLIGHT = 'translate-plus-pending';

  // Same artwork as icons/logo.svg, inlined so pages never need a web-accessible resource.
  const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" aria-hidden="true">'
    + '<path d="M72 16H184A56 56 0 0 1 240 72V184A56 56 0 0 1 184 240H72A56 56 0 0 1 16 184V72A56 56 0 0 1 72 16Z" fill="#0B0B0B"/>'
    + '<path d="M67 49H189A13 13 0 0 1 189 75H67A13 13 0 0 1 67 49Z" fill="#FFFFFF"/>'
    + '<path d="M67 93H133A13 13 0 0 1 133 119H67A13 13 0 0 1 67 93Z" fill="#E3120B"/>'
    + '<path d="M67 137H189A13 13 0 0 1 189 163H67A13 13 0 0 1 67 137Z" fill="#FFFFFF"/>'
    + '<path d="M67 181H133A13 13 0 0 1 133 207H67A13 13 0 0 1 67 181Z" fill="#E3120B"/>'
    + '</svg>';

  const STYLE = `
    :host { all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647; }
    .tp {
      position: fixed; box-sizing: border-box; width: ${SIZE}px; height: ${SIZE}px; margin: 0; padding: 0;
      border: 0; border-radius: 5px; background: #0b0b0b; cursor: pointer; display: block;
      box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.92), 0 2px 8px rgba(0, 0, 0, 0.28);
      transition: transform 0.12s ease;
      animation: tp-in 0.14s ease-out;
    }
    .tp[hidden] { display: none; }
    .tp:hover { transform: scale(1.1); }
    .tp:active { transform: scale(0.96); }
    .tp svg { display: block; width: 100%; height: 100%; }
    @keyframes tp-in { from { opacity: 0; transform: scale(0.7); } to { opacity: 1; transform: scale(1); } }

    .toast {
      position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
      box-sizing: border-box; max-width: min(460px, calc(100vw - 32px)); width: max-content;
      display: flex; align-items: center; gap: 10px; padding: 9px 14px 9px 10px;
      border-radius: 10px; background: #0b0b0b; color: #fff; pointer-events: none;
      font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: normal;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.16), 0 8px 28px rgba(0, 0, 0, 0.32);
      animation: toast-in 0.16s ease-out;
    }
    .toast[hidden] { display: none; }
    .toast.is-error { box-shadow: inset 3px 0 0 #e3120b, 0 0 0 1px rgba(255, 255, 255, 0.16), 0 8px 28px rgba(0, 0, 0, 0.32); }
    .toast .mark { flex: none; width: 18px; height: 18px; }
    .toast .mark svg { display: block; width: 100%; height: 100%; }
    .toast .spin {
      flex: none; box-sizing: border-box; width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.25); border-top-color: #fff; animation: spin 0.8s linear infinite;
    }
    .toast .spin[hidden] { display: none; }
    @keyframes toast-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .tp, .toast { animation: none; transition: none; } }
  `;

  const STRINGS = {
    en: {
      hint: 'Translate+ · Shift+click translates in place',
      translating: 'Translating…',
      done: 'Translated · {undo} brings the original back',
      restored: 'Original text is back',
      changed: 'The text changed while it was being translated, so nothing was replaced',
      tooLong: 'Too much text: in place, up to {n} characters at a time',
      failed: 'Could not translate',
      reload: 'Translate+ was updated. Reload the page.',
    },
    ru: {
      hint: 'Translate+ · Shift+клик — перевести на месте',
      translating: 'Перевожу…',
      done: 'Переведено · {undo} — вернуть оригинал',
      restored: 'Оригинал возвращён',
      changed: 'Пока шёл перевод, текст изменился — ничего не заменено',
      tooLong: 'Слишком много текста: на месте — до {n} символов за раз',
      failed: 'Не удалось перевести',
      reload: 'Translate+ обновился — перезагрузите страницу',
    },
  };
  const UNDO_KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z';

  let enabled = true;
  let lang = 'en';
  let host = null;
  let root = null;
  let button = null;
  let toastBox = null;
  let toastTimer = 0;
  let current = null;   // { text, field?, pointer? } for the selection the icon belongs to
  let pointer = null;   // last mouse-up position, used for text fields
  let frame = 0;
  const undoStack = []; // in-place translations of page text: [{node, before, after}][]

  const say = (key, vars = {}) => (STRINGS[lang][key] ?? STRINGS.en[key])
    .replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));

  // ---------------------------------------------------------------- selection

  const isTextField = (el) => !!el && (el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && /^(text|search|url|tel|email)$/i.test(el.type)));

  const isEditable = (el) => !!el && (isTextField(el) || el.isContentEditable === true
    || el.tagName === 'INPUT' || el.tagName === 'SELECT');

  const normalize = (text) => text
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  function selectionIsEmpty() {
    const active = document.activeElement;
    if (isTextField(active)) {
      try { if (active.selectionStart !== active.selectionEnd) return false; } catch { /* some input types throw */ }
    }
    const sel = window.getSelection();
    return !sel || sel.isCollapsed;
  }

  function readSelection() {
    const active = document.activeElement;
    if (isTextField(active)) {
      let text = '';
      try { text = active.value.slice(active.selectionStart, active.selectionEnd); } catch { /* ignore */ }
      if (text.trim()) return { text, field: active };
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString();
    return text.trim() ? { text } : null;
  }

  /** Viewport rect of the last visible line fragment of the selection. */
  function endRect(range) {
    const rects = range.getClientRects();
    const w = document.documentElement.clientWidth || window.innerWidth;
    const h = document.documentElement.clientHeight || window.innerHeight;
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      if (r.width > 0.5 && r.height > 0.5 && r.bottom > 0 && r.top < h && r.right > 0 && r.left < w) return r;
    }
    return null;
  }

  function isRtl(range) {
    const node = range.endContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!el && getComputedStyle(el).direction === 'rtl';
  }

  /** Where the icon goes for the current selection, or null when the end is off-screen. */
  function targetPosition() {
    const w = document.documentElement.clientWidth || window.innerWidth;
    const h = document.documentElement.clientHeight || window.innerHeight;
    let x;
    let y;

    if (current.field) {
      const p = current.pointer ?? (() => {
        const r = current.field.getBoundingClientRect();
        return { x: r.left + 12, y: r.bottom - SIZE };
      })();
      x = p.x + GAP + 2;
      y = p.y + 14;
    } else {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      const rect = endRect(range);
      if (!rect) return null;
      x = isRtl(range) ? rect.left - SIZE - GAP : rect.right + GAP;
      y = rect.bottom + 2;
      if (y + SIZE > h - EDGE) y = rect.top - SIZE - 2; // no room below: sit above the line
    }

    return {
      x: Math.min(Math.max(x, EDGE), w - SIZE - EDGE),
      y: Math.min(Math.max(y, EDGE), h - SIZE - EDGE),
    };
  }

  // ---------------------------------------------------------- icon and toast

  function ensureRoot() {
    if (host) return;
    host = document.createElement('translate-plus-root');
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.append(style);

    // Keep the page selection alive while the icon is pressed.
    host.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    host.addEventListener('mouseup', (e) => e.stopPropagation());
    host.addEventListener('click', activate);
    document.documentElement.appendChild(host);
  }

  function ensureIcon() {
    if (button) return;
    ensureRoot();
    button = document.createElement('button');
    button.className = 'tp';
    button.type = 'button';
    button.hidden = true;
    button.innerHTML = LOGO;
    setHint();
    root.append(button);
  }

  function setHint() {
    if (!button) return;
    button.title = say('hint');
    button.setAttribute('aria-label', say('hint'));
  }

  function showIcon() {
    const pos = current && targetPosition();
    if (!pos) { if (button) button.hidden = true; return; }
    ensureIcon();
    const wasHidden = button.hidden;
    button.style.left = `${Math.round(pos.x)}px`;
    button.style.top = `${Math.round(pos.y)}px`;
    button.hidden = false;
    if (wasHidden) { // replay the pop-in animation
      button.style.animation = 'none';
      void button.offsetWidth;
      button.style.animation = '';
    }
  }

  function hideIcon() {
    current = null;
    if (button) button.hidden = true;
  }

  /** kind: 'busy' stays until replaced; 'done' and 'error' fade on their own. */
  function toast(text, kind) {
    ensureRoot();
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'toast';
      toastBox.setAttribute('role', 'status');
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.innerHTML = LOGO;
      const label = document.createElement('span');
      label.className = 'label';
      const spin = document.createElement('span');
      spin.className = 'spin';
      toastBox.append(mark, label, spin);
      root.append(toastBox);
    }
    clearTimeout(toastTimer);
    toastBox.querySelector('.label').textContent = text;
    toastBox.querySelector('.spin').hidden = kind !== 'busy';
    toastBox.classList.toggle('is-error', kind === 'error');
    if (toastBox.hidden) { // replay the slide-in animation
      toastBox.hidden = false;
      toastBox.style.animation = 'none';
      void toastBox.offsetWidth;
      toastBox.style.animation = '';
    }
    if (kind !== 'busy') toastTimer = setTimeout(hideToast, kind === 'error' ? 6000 : 3500);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toastBox) toastBox.hidden = true;
  }

  /** False once the extension was reloaded or updated under this page: it cannot be reached any more. */
  const connected = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  function activate(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!current) return;
    if (!connected()) {
      hideIcon();
      toast(say('reload'), 'error');
      return;
    }
    if (event.shiftKey) {
      const job = captureJob(current);
      hideIcon();
      if (job) runInPlace(job);
      return;
    }
    const text = normalize(current.text);
    hideIcon();
    if (!text) return;
    chrome.runtime.sendMessage({ type: 'translate-selection', text }).catch(() => {});
  }

  function evaluate() {
    if (!enabled) { hideIcon(); return; }
    const sel = readSelection();
    if (!sel) { hideIcon(); return; }
    current = { ...sel, pointer: sel.field ? pointer : null };
    showIcon();
  }

  const isOwnEvent = (event) => !!host && event.composedPath().includes(host);

  // ----------------------------------------------------------------- in place
  //
  // Three kinds of selection, three ways to put the translation in:
  // - a text field: the browser's own insertText, so Ctrl+Z and the site's handlers work;
  // - a rich-text editor (contenteditable): the same insertText;
  // - ordinary page text: every block (paragraph, list item, cell, line after <br>)
  //   is translated as a whole and written into one of its text nodes; the other
  //   text nodes of that block are emptied. Paragraphs and the page layout stay;
  //   bold, links and other inline markup inside a translated block are lost.
  //   Only text nodes change, so frameworks that own the DOM keep working.

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'select', 'option',
    'svg', 'math', 'canvas', 'iframe', 'object', 'translate-plus-root']);

  function editableRoot(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    if (!el?.isContentEditable) return null;
    while (el.parentElement?.isContentEditable) el = el.parentElement;
    return el;
  }

  /** Leading and trailing whitespace of `original` around `text`; collapsed to one space unless `exact`. */
  function wrap(original, text, exact) {
    const lead = original.match(/^\s*/)[0];
    const trail = original.match(/\s*$/)[0];
    return exact
      ? lead + text + trail
      : (lead ? ' ' : '') + text + (trail ? ' ' : '');
  }

  /** The selected page text, cut into blocks; each block lists the text nodes (units) it covers. */
  function collectSegments(range) {
    const styles = new Map();
    const style = (el) => {
      let s = styles.get(el);
      if (!s) { s = getComputedStyle(el); styles.set(el, s); }
      return s;
    };
    const blockOf = (el) => {
      while (el.parentElement && el !== document.body && /^(inline|contents)$/.test(style(el).display)) el = el.parentElement;
      return el;
    };
    const depth = (node, block) => {
      let n = 0;
      for (let el = node.parentElement; el && el !== block; el = el.parentElement) n++;
      return n;
    };

    const top = range.commonAncestorContainer;
    const walker = document.createTreeWalker(top.nodeType === 1 ? top : top.parentNode, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (SKIP_TAGS.has(n.localName) || n.isContentEditable || style(n).display === 'none') return NodeFilter.FILTER_REJECT;
        return n.localName === 'br' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });

    const segments = [];
    let seg = null;
    let lineBreak = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 1) { lineBreak = true; continue; } // <br>
      if (!node.parentElement) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.data.length;
      if (end <= start) continue;
      const block = blockOf(node.parentElement);
      if (!seg || lineBreak || block !== seg.block) {
        seg = { block, units: [], pre: /^(pre|break-spaces)/.test(style(node.parentElement).whiteSpace) };
        segments.push(seg);
        lineBreak = false;
      }
      seg.units.push({ node, start, end, data: node.data, depth: depth(node, block) });
    }

    return segments.flatMap((s) => {
      const raw = s.units.map((u) => u.data.slice(u.start, u.end)).join('').replace(/­/g, '');
      if (!raw.trim()) return [];
      const text = s.pre ? raw.trim() : raw.replace(/\s+/g, ' ').trim();
      // The translation goes into the unit closest to the block itself, so it rarely lands inside a link or <b>.
      const target = s.units.reduce((best, u) => (u.depth < best.depth ? u : best));
      return [{ units: s.units, target, raw, text, pre: s.pre }];
    });
  }

  /** Everything needed to put a translation back in place, taken at the moment of the Shift+click. */
  function captureJob(sel) {
    if (sel.field) {
      const field = sel.field;
      let start;
      let end;
      try { start = field.selectionStart; end = field.selectionEnd; } catch { return null; }
      const original = field.value.slice(start, end);
      if (!original.trim()) return null;
      return { kind: 'field', field, start, original, texts: [original.trim()] };
    }
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) return null;
    const range = s.getRangeAt(0).cloneRange();
    const editable = editableRoot(range.commonAncestorContainer);
    if (editable) {
      const text = normalize(s.toString());
      return text ? { kind: 'editable', root: editable, range, original: range.toString(), texts: [text] } : null;
    }
    const segments = collectSegments(range);
    return segments.length ? { kind: 'page', segments, texts: segments.map((g) => g.text) } : null;
  }

  async function runInPlace(job) {
    const total = job.texts.reduce((n, t) => n + t.length, 0);
    if (total > IN_PLACE_MAX) {
      toast(say('tooLong', { n: IN_PLACE_MAX.toLocaleString(lang) }), 'error');
      return;
    }
    if (job.kind === 'page') {
      window.getSelection()?.removeAllRanges(); // the selection colour would hide the pending mark
      markPending(job);
    }
    toast(say('translating'), 'busy');

    let answer;
    try {
      answer = await chrome.runtime.sendMessage({ type: 'translate-in-place', texts: job.texts });
    } catch {
      answer = { error: say(connected() ? 'failed' : 'reload') };
    } finally {
      unmarkPending(job);
    }
    if (!Array.isArray(answer?.texts) || answer.texts.length !== job.texts.length) {
      toast(answer?.error || say('failed'), 'error');
      return;
    }

    const put = job.kind === 'field' ? putIntoField : job.kind === 'editable' ? putIntoEditable : putIntoPage;
    if (put(job, answer.texts)) toast(say('done', { undo: UNDO_KEYS }), 'done');
    else toast(say('changed'), 'error');
  }

  function putIntoField(job, [translation]) {
    const { field, original } = job;
    if (!field.isConnected || !translation) return false;
    let at = job.start;
    if (field.value.slice(at, at + original.length) !== original) {
      // Text typed before the selection moved it: find the original again if it is unambiguous.
      at = field.value.indexOf(original);
      if (at < 0 || at !== field.value.lastIndexOf(original)) return false;
    }
    const text = wrap(original, translation, true);
    field.focus({ preventScroll: true });
    field.setSelectionRange(at, at + original.length);
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch { /* not supported here */ }
    if (!inserted) {
      field.setRangeText(text, at, at + original.length, 'end');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }

  function putIntoEditable(job, [translation]) {
    const { root: editable, range, original } = job;
    if (!editable.isConnected || !translation || range.toString() !== original) return false;
    editable.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      return document.execCommand('insertText', false, wrap(original, translation, true));
    } catch {
      return false;
    }
  }

  function putIntoPage(job, translations) {
    const changes = [];
    job.segments.forEach((seg, i) => {
      const translation = translations[i]?.trim();
      if (!translation) return;
      // Skip a block the page has rewritten in the meantime.
      if (!seg.units.every((u) => u.node.isConnected && u.node.data === u.data)) return;
      const text = wrap(seg.raw, translation, seg.pre);
      for (const u of seg.units) {
        const after = u.data.slice(0, u.start) + (u === seg.target ? text : '') + u.data.slice(u.end);
        changes.push({ node: u.node, before: u.data, after });
        u.node.data = after;
      }
    });
    if (!changes.length) return false;
    undoStack.push(changes);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    return true;
  }

  /** Puts back the original of the latest in-place translation of page text. */
  function undoInPlace() {
    const changes = undoStack.pop();
    if (!changes) return false;
    let restored = false;
    for (const c of changes) {
      if (c.node.isConnected && c.node.data === c.after) {
        c.node.data = c.before;
        restored = true;
      }
    }
    return restored;
  }

  // While a translation is on its way, its text is tinted (CSS Custom Highlight: no DOM changes).
  let highlightSheet = null;

  function markPending(job) {
    try {
      if (!highlightSheet) {
        highlightSheet = new CSSStyleSheet();
        highlightSheet.replaceSync(`::highlight(${HIGHLIGHT}) { background-color: rgba(227, 18, 11, 0.16); }`);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, highlightSheet];
      }
      let mark = CSS.highlights.get(HIGHLIGHT);
      if (!mark) { mark = new Highlight(); CSS.highlights.set(HIGHLIGHT, mark); }
      job.marks = job.segments.map((seg) => {
        const r = document.createRange();
        const first = seg.units[0];
        const last = seg.units[seg.units.length - 1];
        r.setStart(first.node, first.start);
        r.setEnd(last.node, last.end);
        mark.add(r);
        return r;
      });
    } catch { /* cosmetic only */ }
  }

  function unmarkPending(job) {
    try {
      const mark = CSS.highlights.get(HIGHLIGHT);
      for (const r of job.marks ?? []) mark?.delete(r);
    } catch { /* cosmetic only */ }
  }

  // ------------------------------------------------------------------- events

  document.addEventListener('mousedown', (e) => { if (!isOwnEvent(e)) hideIcon(); }, true);

  document.addEventListener('mouseup', (e) => {
    if (isOwnEvent(e)) return;
    pointer = { x: e.clientX, y: e.clientY };
    setTimeout(evaluate, 15); // the browser finalises the selection just after mouseup
  }, true);

  document.addEventListener('keydown', (e) => {
    // Ctrl+Z (by key position, so any keyboard layout) outside editable fields takes back page text.
    if (!undoStack.length || e.code !== 'KeyZ' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (isEditable(e.target) || isEditable(document.activeElement)) return;
    if (undoInPlace()) {
      e.preventDefault();
      e.stopPropagation();
      toast(say('restored'), 'done');
    }
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Escape') { hideIcon(); return; }
    if (e.shiftKey || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) {
      pointer = null;
      evaluate();
    }
  }, true);

  document.addEventListener('selectionchange', () => {
    if (current && selectionIsEmpty()) hideIcon();
  });

  window.addEventListener('scroll', () => {
    if (!current || frame) return;
    if (current.field) { hideIcon(); return; }
    frame = 1;
    const run = () => {
      if (!frame) return;
      frame = 0;
      showIcon();
    };
    requestAnimationFrame(run);
    setTimeout(run, 80); // animation frames are paused while the tab is hidden
  }, true);

  window.addEventListener('resize', hideIcon);

  // ----------------------------------------------------------------- settings

  function applySettings(settings) {
    enabled = settings?.showIcon !== false;
    lang = settings?.uiLang === 'ru' ? 'ru' : 'en';
    setHint();
    if (!enabled) hideIcon();
  }

  try {
    chrome.storage.local.get('settings').then(({ settings }) => applySettings(settings)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
    });
  } catch { /* extension context is gone */ }
})();
