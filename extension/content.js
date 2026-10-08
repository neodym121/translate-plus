// Shows the Translate+ logo at the end of selected text. A click sends the text
// to the background worker, which opens the translator window.
(() => {
  'use strict';
  if (window.__translatePlusLoaded) return;
  window.__translatePlusLoaded = true;

  const SIZE = 22;      // icon size, px
  const GAP = 4;        // distance from the end of the selection
  const EDGE = 6;       // minimum distance from the viewport edge

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
    @media (prefers-reduced-motion: reduce) { .tp { animation: none; transition: none; } }
  `;

  let enabled = true;
  let host = null;
  let button = null;
  let current = null;   // { text, field?, pointer? } for the selection the icon belongs to
  let pointer = null;   // last mouse-up position, used for text fields
  let frame = 0;

  // ---------------------------------------------------------------- selection

  const isTextField = (el) => !!el && (el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && /^(text|search|url|tel|email)$/i.test(el.type)));

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

  // --------------------------------------------------------------------- icon

  function ensureIcon() {
    if (host) return;
    host = document.createElement('translate-plus-root');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    button = document.createElement('button');
    button.className = 'tp';
    button.type = 'button';
    button.title = 'Translate+';
    button.setAttribute('aria-label', 'Translate+');
    button.hidden = true;
    button.innerHTML = LOGO;
    root.append(style, button);

    // Keep the page selection alive while the icon is pressed.
    host.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    host.addEventListener('mouseup', (e) => e.stopPropagation());
    host.addEventListener('click', activate);
    document.documentElement.appendChild(host);
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

  function activate(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!current) return;
    const text = normalize(current.text);
    hideIcon();
    if (!text) return;
    try {
      chrome.runtime.sendMessage({ type: 'translate-selection', text }).catch(() => {});
    } catch { /* the extension was reloaded; this page needs a refresh */ }
  }

  function evaluate() {
    if (!enabled) { hideIcon(); return; }
    const sel = readSelection();
    if (!sel) { hideIcon(); return; }
    current = { ...sel, pointer: sel.field ? pointer : null };
    showIcon();
  }

  const isOwnEvent = (event) => !!host && event.composedPath().includes(host);

  // ------------------------------------------------------------------- events

  document.addEventListener('mousedown', (e) => { if (!isOwnEvent(e)) hideIcon(); }, true);

  document.addEventListener('mouseup', (e) => {
    if (isOwnEvent(e)) return;
    pointer = { x: e.clientX, y: e.clientY };
    setTimeout(evaluate, 15); // the browser finalises the selection just after mouseup
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

  try {
    chrome.storage.local.get('settings').then(({ settings }) => {
      enabled = settings?.showIcon !== false;
    }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      enabled = changes.settings.newValue?.showIcon !== false;
      if (!enabled) hideIcon();
    });
  } catch { /* extension context is gone */ }
})();
