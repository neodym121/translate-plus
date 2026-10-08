import { LANGUAGES, languageName, normalizeLangCode } from '../lib/languages.js';
import { loadSettings, saveSettings, DEFAULT_MODELS } from '../lib/settings.js';
import {
  PROVIDERS, translate, configureCache, listModels, polzaVendors, polzaModels, recommendPolzaModel,
} from '../lib/providers.js';
import { makeT, pickLocale, errorMessage } from '../lib/i18n.js';

const MAX_CHARS = 10000;
const AUTO_DELAY = 700;               // ms after the last keystroke before translating
const LIST_TTL = 24 * 3600e3;         // how long a fetched model list is trusted before it is refreshed
const PENDING_TTL = 15e3;             // how long text from the page icon stays valid

const standalone = new URLSearchParams(location.search).has('window');
if (standalone) document.documentElement.classList.add('standalone');

// The interface language comes from the settings (English by default) and can change while the window is open.
let locale = 'en';
let t = makeT(locale);

function setLocale(code) {
  locale = pickLocale(code);
  t = makeT(locale);
  document.documentElement.lang = locale;
}

const $ = (id) => document.getElementById(id);
const el = {
  main: $('view-main'),
  settings: $('view-settings'),
  detected: $('detected'),
  target: $('target'),
  source: $('source'),
  count: $('count'),
  clear: $('btn-clear'),
  copy: $('btn-copy'),
  result: $('result'),
  resultCard: $('result-card'),
  actions: $('result-actions'),
  providerList: $('provider-list'),
  showIcon: $('show-icon'),
  darkTheme: $('dark-theme'),
  uiLang: $('ui-lang'),
};

const state = {
  settings: null,
  selectionMode: false, // opened with text selected on a page: only the translation is shown
  panels: {},         // provider id -> { item, inner, built }: the key/model box under each AI provider's row
  cache: {},          // model lists: { groq|gemini: {models: [{id, group}], at}, polzaVendors: {list, at}, polza: {vendor: {models, at}} }
  abort: null,
  requestId: 0,
  timer: 0,
  copyTimer: 0,
  lastOutput: '',
  detected: null,     // source language shown in the badge
  resultKind: 'empty',
  error: null,        // the error on screen, kept so it can be worded again in another language
  truncated: false,
  dirty: false,       // provider settings changed since the last translation
};

// ------------------------------------------------------------------ helpers

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'value' || key === 'checked') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children);
  return node;
}

const ICONS = {
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.7C3.7 8.6 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.1-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.6L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.6L20 16M20 20v-4h-4"/></svg>',
};

function iconButton(icon, label, extraClass = '') {
  const button = h('button', { class: `icon-btn ${extraClass}`.trim(), type: 'button', title: label, 'aria-label': label });
  button.innerHTML = icon; // constant markup from ICONS, never user data
  return button;
}

const cleanText = (text) => text
  .replace(/ /g, ' ')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const persist = () => saveSettings(state.settings);

async function loadCache() {
  state.cache = (await chrome.storage.local.get('modelCache')).modelCache ?? {};
}
const saveCache = () => chrome.storage.local.set({ modelCache: state.cache });

// ------------------------------------------------------------- static text

function applyStaticText() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  for (const node of document.querySelectorAll('[data-i18n-label]')) {
    const label = t(node.dataset.i18nLabel);
    node.setAttribute('aria-label', label);
    node.title = label;
  }
  el.source.dir = 'auto';
  el.result.dir = 'auto';
}

function buildLanguageSelect() {
  const collator = new Intl.Collator(locale);
  const options = LANGUAGES
    .map((code) => ({ code, name: languageName(code, locale) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  el.target.replaceChildren(...options.map((o) => new Option(o.name, o.code)));
  el.target.value = state.settings.targetLang;
}

// ----------------------------------------------------------- main screen UI

function setDetected(code) {
  state.detected = code ?? null;
  el.detected.textContent = code ? languageName(code, locale) : t('detectAuto');
  el.detected.title = code ?? '';
}

function setResult(kind, text, actions = []) {
  state.resultKind = kind;
  el.result.className = kind === 'done' ? 'result-text' : `result-text is-${kind}`;
  el.result.textContent = text;
  el.copy.hidden = kind !== 'done';
  el.resultCard.classList.toggle('has-copy', kind === 'done');
  el.actions.replaceChildren(...actions);
  el.actions.hidden = actions.length === 0;
}

function resetResult() {
  state.lastOutput = '';
  setDetected(null);
  setResult('empty', t('resultEmpty'));
}

function updateCount(truncated = false) {
  state.truncated = truncated;
  const length = el.source.value.length;
  el.count.textContent = truncated ? t('truncated', { n: MAX_CHARS }) : length ? `${length} / ${MAX_CHARS}` : '';
  el.clear.hidden = length === 0;
}

function setSource(text) {
  const truncated = text.length > MAX_CHARS;
  el.source.value = truncated ? text.slice(0, MAX_CHARS) : text;
  updateCount(truncated);
}

/** Selected-text mode hides the input box; typed mode shows it. */
function setSelectionMode(on) {
  state.selectionMode = on;
  el.main.classList.toggle('is-selection', on);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('translate-plus-theme', theme); } catch { /* theme.js falls back to light */ }
}

function showView(name) {
  el.main.hidden = name !== 'main';
  el.settings.hidden = name !== 'settings';
}

function renderError(error) {
  const provider = state.settings.provider;
  const needsSettings = ['no_key', 'auth', 'balance', 'model'].includes(error?.code);
  const action = needsSettings
    ? h('button', { class: 'btn', type: 'button' }, t('openSettings'))
    : h('button', { class: 'btn', type: 'button' }, t('retry'));
  action.addEventListener('click', needsSettings ? openSettings : translateNow);
  state.error = error;
  setResult('error', errorMessage(t, error, PROVIDERS[provider].name), [action]);
  el.detected.title = '';
}

// -------------------------------------------------------------- translating

async function detectSource(reported, text) {
  if (reported) return normalizeLangCode(reported);
  try {
    const result = await chrome.i18n.detectLanguage(text);
    const top = result?.languages?.[0];
    return top && top.language !== 'und' ? normalizeLangCode(top.language) : null;
  } catch {
    return null;
  }
}

async function translateNow() {
  clearTimeout(state.timer);
  state.abort?.abort();
  state.dirty = false;

  const text = cleanText(el.source.value);
  if (!text) {
    state.requestId++;
    resetResult();
    return;
  }

  const id = ++state.requestId;
  const controller = new AbortController();
  state.abort = controller;
  const { provider, targetLang } = state.settings;
  setResult('loading', t('translating'));

  try {
    const out = await translate({ provider, text, target: targetLang, settings: state.settings, signal: controller.signal });
    if (id !== state.requestId) return;
    const detected = await detectSource(out.detected, text);
    if (id !== state.requestId) return;
    state.lastOutput = out.text;
    setDetected(detected);
    setResult('done', out.text);
    // Only text the user typed is remembered; selected page text is never brought back.
    if (!state.selectionMode) {
      chrome.storage.session.set({ last: { text, output: out.text, detected, provider, targetLang } }).catch(() => {});
    }
  } catch (error) {
    if (id !== state.requestId || error?.name === 'AbortError') return;
    renderError(error);
  }
}

function scheduleTranslate(delay = AUTO_DELAY) {
  clearTimeout(state.timer);
  if (!cleanText(el.source.value)) {
    state.abort?.abort();
    state.requestId++;
    resetResult();
    return;
  }
  state.timer = setTimeout(translateNow, delay);
}

// ---------------------------------------------------------- incoming text

// Runs inside the page (and its frames); must not reference anything outside itself.
function selectedTextInPage() {
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|tel|email)$/i.test(a.type)))) {
    try {
      const picked = a.value.slice(a.selectionStart, a.selectionEnd);
      if (picked.trim()) return picked;
    } catch { /* some input types throw */ }
  }
  return String(window.getSelection() ?? '');
}

async function readPageSelection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return '';
    const run = (allFrames) => chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames }, func: selectedTextInPage });
    let results;
    try {
      results = await run(true);
    } catch {
      results = await run(false); // a frame we may not touch made the all-frames call fail
    }
    return results.map((r) => r.result).find((s) => typeof s === 'string' && s.trim()) ?? '';
  } catch {
    return ''; // chrome:// pages, the Web Store, PDFs: nothing to read
  }
}

/** Text sent by the in-page icon, else the current selection of the active tab. */
async function takeIncomingText() {
  const { pending } = await chrome.storage.session.get('pending');
  if (pending) {
    await chrome.storage.session.remove('pending');
    if (Date.now() - pending.at < PENDING_TTL && pending.text?.trim()) return pending.text;
  }
  return standalone ? '' : readPageSelection();
}

/** Brings back the text the user last typed here (never selected page text). */
async function restoreLast() {
  const { last } = await chrome.storage.session.get('last');
  if (!last?.text) return false;
  setSource(last.text);
  const { provider, targetLang } = state.settings;
  if (last.provider === provider && last.targetLang === targetLang) {
    state.lastOutput = last.output;
    setDetected(last.detected);
    setResult('done', last.output);
  } else {
    translateNow();
  }
  return true;
}

/** Text taken from a page selection: show only its translation. */
function receive(text) {
  showView('main');
  setSelectionMode(true);
  chrome.storage.session.remove('last').catch(() => {});
  setSource(text);
  el.source.blur();
  translateNow();
}

// ------------------------------------------------------------------ copying

async function copyOutput() {
  const text = state.lastOutput;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const scratch = h('textarea', { style: 'position:fixed;opacity:0' });
    scratch.value = text;
    document.body.append(scratch);
    scratch.select();
    document.execCommand('copy');
    scratch.remove();
  }
  el.copy.classList.add('copied');
  el.copy.title = t('copied');
  clearTimeout(state.copyTimer);
  state.copyTimer = setTimeout(() => {
    el.copy.classList.remove('copied');
    el.copy.title = t('copy');
  }, 1400);
}

// ----------------------------------------------------------------- settings

function openSettings() {
  renderProviderList();
  syncLocaleSwitch();
  el.showIcon.checked = state.settings.showIcon;
  el.darkTheme.checked = state.settings.theme === 'dark';
  showView('settings');
}

function syncLocaleSwitch() {
  for (const input of el.uiLang.querySelectorAll('input')) input.checked = input.value === locale;
}

/** Switches the interface language in place: every word on both screens is written again. */
function chooseLocale(code) {
  state.settings.uiLang = code;
  persist();
  setLocale(code);
  applyStaticText();
  buildLanguageSelect();
  renderProviderList();
  setDetected(state.detected);
  updateCount(state.truncated);
  if (state.resultKind === 'empty') setResult('empty', t('resultEmpty'));
  else if (state.resultKind === 'loading') setResult('loading', t('translating'));
  else if (state.resultKind === 'error' && state.error) renderError(state.error);
}

function closeSettings() {
  showView('main');
  if (state.dirty && cleanText(el.source.value)) translateNow();
}

const PROVIDER_NOTES = {
  google: 'providerFree', bing: 'providerFree', groq: 'providerGroq', polza: 'providerPolza', gemini: 'providerGemini',
};

function renderProviderList() {
  state.panels = {};
  el.providerList.replaceChildren(...Object.entries(PROVIDERS).map(([id, info]) => {
    const input = h('input', { type: 'radio', name: 'provider', value: id, checked: id === state.settings.provider });
    input.addEventListener('change', () => chooseProvider(id));
    const item = h('div', { class: 'prov' },
      h('label', { class: 'prov-row' },
        input,
        h('span', { class: 'prov-text' },
          h('span', { class: 'prov-name' }, info.name),
          h('span', { class: 'prov-note' }, t(PROVIDER_NOTES[id]))),
        h('span', { class: 'radio-dot' })));
    if (info.needsKey) {
      // The key and model box lives inside the provider's own item, below its row.
      const inner = h('div', { class: 'prov-panel-inner' });
      item.append(h('div', { class: 'prov-panel' }, inner));
      state.panels[id] = { item, inner, built: false };
    }
    return item;
  }));
  syncPanels();
}

function chooseProvider(id) {
  state.settings.provider = id;
  state.dirty = true;
  persist();
  syncPanels({ reveal: true });
}

/** The chosen AI provider's key and model box drops out under its own row; the others fold up. */
function syncPanels({ reveal = false } = {}) {
  const active = state.settings.provider;
  for (const [id, panel] of Object.entries(state.panels)) {
    const open = id === active;
    if (open && !panel.built) {
      panel.inner.replaceChildren(id === 'polza' ? renderPolza() : renderKeyedProvider(id));
      panel.built = true;
    }
    panel.item.classList.toggle('open', open);
  }
  if (reveal && state.panels[active]) {
    // once the box has unfolded, make sure all of it is on screen
    setTimeout(() => state.panels[active]?.item.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 280);
  }
}

function fillSelect(select, options, selected) {
  const list = !selected || options.some((o) => o.value === selected)
    ? options
    : [{ value: selected, label: selected }, ...options];
  select.replaceChildren(...list.map((o) => new Option(o.label, o.value)));
  if (selected) select.value = selected;
}

/** Models as options, under a heading per developer / family when the list has several. */
function fillModels(select, models, selected) {
  const nodes = [];
  if (selected && !models.some((m) => m.id === selected)) nodes.push(new Option(selected, selected)); // a saved choice that is no longer listed
  const groups = new Map();
  for (const m of models) {
    const name = m.group ?? '';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(m);
  }
  if (groups.size <= 1) {
    nodes.push(...models.map((m) => new Option(m.id, m.id)));
  } else {
    for (const [name, list] of groups) {
      const group = h('optgroup', { label: name || t('otherModels') });
      group.append(...list.map((m) => new Option(m.id, m.id)));
      nodes.push(group);
    }
  }
  select.replaceChildren(...nodes);
  if (selected) select.value = selected;
}

function keyField(provider) {
  const cfg = state.settings[provider];
  const id = `key-${provider}`;
  const input = h('input', {
    class: 'input', id, type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: { groq: 'gsk_…', gemini: 'AIza…' }[provider], value: cfg.apiKey,
  });
  const eye = iconButton(ICONS.eye, t('showKey'));
  eye.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    eye.innerHTML = reveal ? ICONS.eyeOff : ICONS.eye;
    eye.title = eye.ariaLabel = reveal ? t('hideKey') : t('showKey');
  });
  input.addEventListener('input', () => {
    cfg.apiKey = input.value.trim();
    state.dirty = true;
    persist();
  });
  return {
    input,
    node: h('div', { class: 'field' },
      h('label', { for: id }, t('apiKey'),
        h('a', { class: 'link', href: PROVIDERS[provider].keyUrl, target: '_blank', rel: 'noreferrer' }, t('getKey'))),
      h('div', { class: 'input-wrap' }, input, eye)),
  };
}

function modelField(provider, { onRefresh }) {
  const id = `model-${provider}`;
  const select = h('select', { class: 'select', id });
  const refresh = iconButton(ICONS.refresh, t('refreshModels'));
  const status = h('div', { class: 'hint status', 'aria-live': 'polite' });
  select.addEventListener('change', () => {
    state.settings[provider].model = select.value;
    state.dirty = true;
    persist();
  });
  refresh.addEventListener('click', () => onRefresh());
  return {
    select,
    status,
    refresh,
    node: h('div', { class: 'field' },
      h('label', { for: id }, t('model')),
      h('div', { class: 'field-row' }, select, refresh),
      status),
  };
}

function setBusy(button, busy) {
  button.classList.toggle('busy', busy);
  button.disabled = busy;
}

// Groq and Gemini: API key + any model the key can use that takes and returns text.
function renderKeyedProvider(provider) {
  const cfg = state.settings[provider];
  const key = keyField(provider);
  const model = modelField(provider, { onRefresh: () => reload() });

  async function reload({ announce = true } = {}) {
    if (!cfg.apiKey) {
      if (announce) model.status.textContent = t('modelsNeedKey');
      return;
    }
    setBusy(model.refresh, true);
    model.status.textContent = '';
    try {
      const models = await listModels(provider, cfg.apiKey);
      state.cache[provider] = { models, at: Date.now() };
      saveCache();
      fillModels(model.select, models, cfg.model);
      if (announce) model.status.textContent = t('modelsUpdated', { n: models.length });
    } catch (error) {
      model.status.textContent = error?.code === 'auth' ? errorMessage(t, error, PROVIDERS[provider].name) : t('modelsFailed');
    } finally {
      setBusy(model.refresh, false);
    }
  }

  const entry = state.cache[provider];
  fillModels(model.select, entry?.models?.length ? entry.models : DEFAULT_MODELS[provider].map((id) => ({ id, group: '' })), cfg.model);
  // A new key, or a list that has gone stale, is the moment to ask what the key can actually use.
  if (cfg.apiKey && !fresh(entry)) reload({ announce: false });
  key.input.addEventListener('change', () => { if (cfg.apiKey) reload(); });

  return h('div', { class: 'config' }, key.node, model.node);
}

// Polza: API key + sub-provider (the model's developer) + one of its models.
const VENDOR_NAMES = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek', 'deepseek-ai': 'DeepSeek AI',
  'x-ai': 'xAI', 'meta-llama': 'Meta', mistralai: 'Mistral AI', qwen: 'Qwen', moonshotai: 'Moonshot AI',
  minimax: 'MiniMax', 'z-ai': 'Z.ai', nvidia: 'NVIDIA', microsoft: 'Microsoft', amazon: 'Amazon', cohere: 'Cohere',
  perplexity: 'Perplexity', bytedance: 'ByteDance', yandex: 'Yandex', 'sber-gigachat': 'Sber GigaChat', gigachat: 'GigaChat',
  stepfun: 'StepFun', xiaomi: 'Xiaomi', tencent: 'Tencent', baidu: 'Baidu', 'ibm-granite': 'IBM Granite', minimaxai: 'MiniMax AI',
};
const POPULAR_VENDORS = ['openai', 'anthropic', 'google', 'deepseek', 'x-ai', 'meta-llama', 'mistralai', 'qwen'];
const vendorLabel = (v) => VENDOR_NAMES[v.toLowerCase()] ?? v.charAt(0).toUpperCase() + v.slice(1);

// The catalog filter ignores case, so "Qwen" and "qwen" are one vendor.
function vendorOptions(vendors) {
  const unique = [...new Map(vendors.map((v) => [v.toLowerCase(), v])).values()];
  const rest = unique.filter((v) => !POPULAR_VENDORS.includes(v.toLowerCase()))
    .sort((a, b) => vendorLabel(a).localeCompare(vendorLabel(b)));
  return [...POPULAR_VENDORS.filter((v) => unique.some((u) => u.toLowerCase() === v)), ...rest]
    .map((value) => ({ value, label: vendorLabel(value) }));
}

const fresh = (entry) => entry && Date.now() - entry.at < LIST_TTL;

function renderPolza() {
  const cfg = state.settings.polza;
  const key = keyField('polza');

  const vendorSelect = h('select', { class: 'select', id: 'polza-vendor' });
  const vendor = h('div', { class: 'field' },
    h('label', { for: 'polza-vendor' }, t('subprovider')),
    vendorSelect,
    h('div', { class: 'hint' }, t('subproviderHint')));

  const model = modelField('polza', { onRefresh: () => loadModels(true) });

  async function loadModels(force = false) {
    const vendorId = cfg.vendor;
    setBusy(model.refresh, true);
    model.status.textContent = '';
    try {
      let entry = state.cache.polza?.[vendorId];
      if (force || !fresh(entry)) {
        entry = { models: await polzaModels(vendorId), at: Date.now() };
        state.cache.polza = { ...state.cache.polza, [vendorId]: entry };
        saveCache();
        if (force) model.status.textContent = t('modelsUpdated', { n: entry.models.length });
      }
      if (vendorId !== cfg.vendor) return; // the user switched vendor meanwhile
      const options = entry.models.map((m) => ({ value: m.id, label: m.name }));
      if (entry.models.length && !entry.models.some((m) => m.id === cfg.model)) {
        cfg.model = recommendPolzaModel(entry.models).id;
        state.dirty = true;
        persist();
      }
      fillSelect(model.select, options, cfg.model);
    } catch {
      model.status.textContent = t('modelsFailed');
      fillSelect(model.select, [], cfg.model);
    } finally {
      setBusy(model.refresh, false);
    }
  }

  async function loadVendors() {
    let list = fresh(state.cache.polzaVendors) ? state.cache.polzaVendors.list : null;
    if (!list) {
      try {
        list = await polzaVendors();
        state.cache.polzaVendors = { list, at: Date.now() };
        saveCache();
      } catch {
        list = state.cache.polzaVendors?.list ?? POPULAR_VENDORS;
      }
    }
    if (!list.includes(cfg.vendor)) list = [cfg.vendor, ...list];
    fillSelect(vendorSelect, vendorOptions(list), cfg.vendor);
  }

  vendorSelect.addEventListener('change', () => {
    cfg.vendor = vendorSelect.value;
    state.dirty = true;
    persist();
    loadModels();
  });

  fillSelect(vendorSelect, vendorOptions([cfg.vendor]), cfg.vendor);
  fillSelect(model.select, [], cfg.model);
  loadVendors();
  loadModels();

  return h('div', { class: 'config' }, key.node, vendor, model.node);
}

// ------------------------------------------------------------------- wiring

function bind() {
  el.source.addEventListener('input', () => {
    updateCount();
    scheduleTranslate();
    chrome.storage.session.remove('last').catch(() => {});
  });
  el.source.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); translateNow(); }
  });
  el.target.addEventListener('change', () => {
    state.settings.targetLang = el.target.value;
    persist();
    translateNow();
  });
  el.clear.addEventListener('click', () => {
    el.source.value = '';
    updateCount();
    scheduleTranslate(0);
    chrome.storage.session.remove('last').catch(() => {});
    el.source.focus();
  });
  el.copy.addEventListener('click', copyOutput);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-back').addEventListener('click', closeSettings);
  el.showIcon.addEventListener('change', () => {
    state.settings.showIcon = el.showIcon.checked;
    persist();
  });
  el.uiLang.addEventListener('change', (e) => chooseLocale(e.target.value));
  el.darkTheme.addEventListener('change', () => {
    state.settings.theme = el.darkTheme.checked ? 'dark' : 'light';
    applyTheme(state.settings.theme);
    persist();
  });

  // Text arriving while the window is already open (standalone window case).
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'session' || !changes.pending?.newValue) return;
    const { text, at } = changes.pending.newValue;
    await chrome.storage.session.remove('pending');
    if (text?.trim() && Date.now() - at < PENDING_TTL) receive(text);
  });
}

async function init() {
  configureCache({
    get: async (key) => (await chrome.storage.session.get(key))[key],
    set: (key, value) => chrome.storage.session.set({ [key]: value }),
  });

  [state.settings] = await Promise.all([loadSettings(), loadCache()]);
  if (!PROVIDERS[state.settings.provider]) state.settings.provider = 'google';
  setLocale(state.settings.uiLang);

  applyTheme(state.settings.theme === 'dark' ? 'dark' : 'light');
  applyStaticText();
  buildLanguageSelect();
  resetResult();
  updateCount();
  bind();

  const incoming = await takeIncomingText();
  if (incoming.trim()) {
    receive(incoming); // selected on a page: translation only, no input box
  } else if (!(await restoreLast())) {
    el.source.focus();
  }
}

init().catch((error) => {
  console.error(error);
  setResult('error', String(error?.message ?? error));
});
