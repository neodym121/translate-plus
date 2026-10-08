import { LANGUAGES, languageName, normalizeLangCode } from '../lib/languages.js';
import { loadSettings, saveSettings, DEFAULT_MODELS, DEFAULT_SETTINGS } from '../lib/settings.js';
import {
  PROVIDERS, translate, configureCache, listModels, polzaModels, polzaRoutes, recommendPolzaModel,
} from '../lib/providers.js';
import { makeT, pickLocale, errorMessage } from '../lib/i18n.js';
import { createDropdown } from './dropdown.js';

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
  access: $('access'),
  accessButton: $('btn-access'),
};

const state = {
  settings: null,
  selectionMode: false, // opened with text selected on a page: only the translation is shown
  panels: {},         // provider id -> { item, inner, note, built }: the key/model box under each AI provider's row
  cache: {},          // model lists: { groq|gemini: {models: [{id, group}], at}, polzaModels: {models, at}, polzaRoutes: {model: {list, at}} }
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
  // 1.1 kept Polza models per developer; 1.2 lists them all at once
  delete state.cache.polza;
  delete state.cache.polzaVendors;
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
  targetPicker.setOptions(options.map((o) => ({ value: o.code, label: o.name })), state.settings.targetLang);
}

/** Strings every dropdown reads when it opens, so they follow the interface language. */
const dropdownTexts = () => ({ search: t('search'), empty: t('noMatches') });

const targetPicker = createDropdown({
  button: el.target,
  texts: dropdownTexts,
  onChange: (code) => {
    state.settings.targetLang = code;
    persist();
    translateNow();
  },
});

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
    return ''; // about: pages, addons.mozilla.org, PDFs: nothing to read
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

// -------------------------------------------------------------- site access

// Firefox lets the user switch an add-on's site access off. Without it the page
// icon is gone and the services cannot be reached, so the popup offers it back.
const manifest = chrome.runtime.getManifest();
const ORIGINS = [...new Set([
  ...(manifest.host_permissions ?? []),
  ...(manifest.content_scripts ?? []).flatMap((c) => c.matches),
])];

async function checkAccess() {
  let granted = true;
  try {
    granted = await chrome.permissions.contains({ origins: ORIGINS });
  } catch { /* nothing to offer then */ }
  el.access.hidden = granted;
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

/** Under each provider's name: free, or whether its API key is already filled in. */
function providerNote(id) {
  if (!PROVIDERS[id].needsKey) return t('providerFree');
  return t(state.settings[id]?.apiKey ? 'providerKeySet' : 'providerNeedsKey');
}

function updateProviderNote(id) {
  const note = state.panels[id]?.note;
  if (note) note.textContent = providerNote(id);
}

function renderProviderList() {
  state.panels = {};
  el.providerList.replaceChildren(...Object.entries(PROVIDERS).map(([id, info]) => {
    const input = h('input', { type: 'radio', name: 'provider', value: id, checked: id === state.settings.provider });
    input.addEventListener('change', () => chooseProvider(id));
    const note = h('span', { class: 'prov-note' }, providerNote(id));
    const item = h('div', { class: 'prov' },
      h('label', { class: 'prov-row' },
        input,
        h('span', { class: 'prov-text' },
          h('span', { class: 'prov-name' }, info.name),
          note),
        h('span', { class: 'radio-dot' })));
    if (info.needsKey) {
      // The key and model box lives inside the provider's own item, below its row.
      const inner = h('div', { class: 'prov-panel-inner' });
      item.append(h('div', { class: 'prov-panel' }, inner));
      state.panels[id] = { item, inner, note, built: false };
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

/** Models as dropdown options, under a heading per developer / family when the list has several. */
function modelOptions(models) {
  const grouped = new Set(models.map((m) => m.group ?? '')).size > 1;
  return models.map((m) => ({
    value: m.id,
    label: m.label ?? m.id,
    group: grouped ? m.group || t('otherModels') : undefined,
  }));
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
    updateProviderNote(provider);
  });
  return {
    input,
    node: h('div', { class: 'field' },
      h('label', { for: id }, t('apiKey'),
        h('a', { class: 'link', href: PROVIDERS[provider].keyUrl, target: '_blank', rel: 'noreferrer' }, t('getKey'))),
      h('div', { class: 'input-wrap' }, input, eye)),
  };
}

function modelField(provider, { onRefresh, onChange }) {
  const id = `model-${provider}`;
  const picker = createDropdown({
    id,
    texts: dropdownTexts,
    onChange: (model) => {
      state.settings[provider].model = model;
      state.dirty = true;
      persist();
      onChange?.(model);
    },
  });
  const refresh = iconButton(ICONS.refresh, t('refreshModels'));
  const status = h('div', { class: 'hint status', 'aria-live': 'polite' });
  refresh.addEventListener('click', () => onRefresh());
  return {
    picker,
    status,
    refresh,
    node: h('div', { class: 'field' },
      h('label', { for: id }, t('model')),
      h('div', { class: 'field-row' }, picker.node, refresh),
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
      model.picker.setOptions(modelOptions(models), cfg.model);
      if (announce) model.status.textContent = t('modelsUpdated', { n: models.length });
    } catch (error) {
      model.status.textContent = error?.code === 'auth' ? errorMessage(t, error, PROVIDERS[provider].name) : t('modelsFailed');
    } finally {
      setBusy(model.refresh, false);
    }
  }

  const entry = state.cache[provider];
  model.picker.setOptions(modelOptions(entry?.models?.length ? entry.models : DEFAULT_MODELS[provider].map((id) => ({ id, group: '' }))), cfg.model);
  // A new key, or a list that has gone stale, is the moment to ask what the key can actually use.
  if (cfg.apiKey && !fresh(entry)) reload({ announce: false });
  key.input.addEventListener('change', () => { if (cfg.apiKey) reload(); });

  return h('div', { class: 'config' }, key.node, model.node);
}

// Polza: API key + one model out of all of Polza's text models + the sub-provider that runs it.
const VENDOR_NAMES = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek', 'deepseek-ai': 'DeepSeek AI',
  'x-ai': 'xAI', 'meta-llama': 'Meta', mistralai: 'Mistral AI', qwen: 'Qwen', moonshotai: 'Moonshot AI',
  minimax: 'MiniMax', 'z-ai': 'Z.ai', nvidia: 'NVIDIA', microsoft: 'Microsoft', amazon: 'Amazon', cohere: 'Cohere',
  perplexity: 'Perplexity', bytedance: 'ByteDance', 'bytedance-seed': 'ByteDance Seed', yandex: 'Yandex',
  'sber-gigachat': 'Sber GigaChat', gigachat: 'GigaChat', stepfun: 'StepFun', xiaomi: 'Xiaomi', tencent: 'Tencent',
  baidu: 'Baidu', 'ibm-granite': 'IBM Granite', minimaxai: 'MiniMax AI', nousresearch: 'Nous Research',
  'arcee-ai': 'Arcee AI', 'aion-labs': 'Aion Labs', 'inference-net': 'Inference.net', 'nex-agi': 'Nex AGI',
  rekaai: 'Reka AI', sao10k: 'Sao10K', 'anthracite-org': 'Anthracite', thudm: 'THUDM', 'ai21': 'AI21',
};
const POPULAR_VENDORS = ['openai', 'anthropic', 'google', 'deepseek', 'x-ai', 'meta-llama', 'mistralai', 'qwen'];

// Sub-provider ids as Polza gives them ("deepinfra/turbo", "google-vertex/us-central1", "Cerebras").
const ROUTE_NAMES = {
  azure: 'Azure', openai: 'OpenAI', anthropic: 'Anthropic', 'cloud-ru': 'Cloud.ru', deepinfra: 'DeepInfra',
  'google-vertex': 'Google Vertex', 'google-ai-studio': 'Google AI Studio', 'amazon-bedrock': 'Amazon Bedrock',
  together: 'Together', novita: 'Novita', nebius: 'Nebius', parasail: 'Parasail', crusoe: 'Crusoe',
  cloudflare: 'Cloudflare', sambanova: 'SambaNova', 'sambanova-turbo': 'SambaNova Turbo', wandb: 'W&B',
  'wandb-legacy': 'W&B Legacy', coreweave: 'CoreWeave', akash: 'Akash', akashml: 'AkashML',
  siliconflow: 'SiliconFlow', 'atlas-cloud': 'Atlas Cloud', gmicloud: 'GMI Cloud', primeintellect: 'Prime Intellect',
  alibaba: 'Alibaba', groq: 'Groq', friendli: 'Friendli', chutes: 'Chutes', hyperbolic: 'Hyperbolic',
  fireworks: 'Fireworks', cerebras: 'Cerebras', modelrun: 'ModelRun', mara: 'Mara', venice: 'Venice',
  streamlake: 'StreamLake', inceptron: 'Inceptron', drouter: 'DRouter', 'claude-on-aws': 'Claude on AWS',
  mistral: 'Mistral', xai: 'xAI', deepseek: 'DeepSeek', moonshotai: 'Moonshot AI', baseten: 'Baseten',
  lambda: 'Lambda', infermatic: 'Infermatic', 'z-ai': 'Z.ai', minimax: 'MiniMax',
};

const titleCase = (s) => s.split(/[-_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const vendorLabel = (v) => VENDOR_NAMES[v.toLowerCase()] ?? titleCase(v);

/** "google-vertex/us-central1" -> "Google Vertex · us-central1" */
function routeLabel(name) {
  const [base, ...rest] = name.split('/');
  const label = ROUTE_NAMES[base.toLowerCase()] ?? (base === base.toLowerCase() ? titleCase(base) : base);
  return rest.length ? `${label} · ${rest.join('/')}` : label;
}

const rubles = (n) => new Intl.NumberFormat(locale, { maximumFractionDigits: n < 10 ? 2 : n < 100 ? 1 : 0 }).format(n);

/** All models in one list: popular developers first, then the rest A-Z, each developer under its heading. */
function polzaModelOptions(models) {
  const rank = (v) => {
    const i = POPULAR_VENDORS.indexOf(v.toLowerCase());
    return i < 0 ? POPULAR_VENDORS.length : i;
  };
  const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return [...models]
    .map((m) => {
      const vendor = m.vendor ?? m.id.split('/')[0];
      // "OpenAI: GPT-4o-mini" is "GPT-4o-mini" under the OpenAI heading
      return { value: m.id, label: m.name.replace(/^[^:]{1,40}:\s+/, ''), vendor, group: vendorLabel(vendor) };
    })
    .sort((a, b) => rank(a.vendor) - rank(b.vendor) || byName.compare(a.group, b.group) || byName.compare(a.label, b.label))
    .map(({ value, label, group }) => ({ value, label, group }));
}

function routeOptions(routes) {
  return [
    { value: '', label: t('routeAuto'), detail: t('routeAutoNote') },
    ...routes.map((r) => ({
      value: r.name,
      label: routeLabel(r.name),
      detail: r.prompt || r.completion ? t('routePrice', { in: rubles(r.prompt), out: rubles(r.completion) }) : undefined,
    })),
  ];
}

const fresh = (entry) => entry && Date.now() - entry.at < LIST_TTL;

function renderPolza() {
  const cfg = state.settings.polza;
  const key = keyField('polza');

  const model = modelField('polza', {
    onRefresh: () => loadModels(true),
    onChange: () => {
      cfg.route = ''; // the sub-providers differ from model to model
      persist();
      loadRoutes();
    },
  });

  const route = createDropdown({
    id: 'polza-route',
    texts: dropdownTexts,
    onChange: (name) => {
      cfg.route = name;
      state.dirty = true;
      persist();
    },
  });
  const routeStatus = h('div', { class: 'hint status', 'aria-live': 'polite' });
  const routeNode = h('div', { class: 'field' },
    h('label', { for: 'polza-route' }, t('subprovider')),
    route.node,
    h('div', { class: 'hint' }, t('subproviderHint')),
    routeStatus);

  async function loadModels(force = false) {
    setBusy(model.refresh, true);
    model.status.textContent = '';
    try {
      let entry = state.cache.polzaModels;
      if (force || !fresh(entry) || !entry.models?.length) {
        entry = { models: await polzaModels(), at: Date.now() };
        state.cache.polzaModels = entry;
        saveCache();
        if (force) model.status.textContent = t('modelsUpdated', { n: entry.models.length });
      }
      if (entry.models.length && !entry.models.some((m) => m.id === cfg.model)) {
        // the saved model is gone: the default one if Polza still has it, else a cheap and fast one
        const fallback = DEFAULT_SETTINGS.polza.model;
        cfg.model = entry.models.some((m) => m.id === fallback) ? fallback : recommendPolzaModel(entry.models).id;
        cfg.route = '';
        state.dirty = true;
        persist();
        loadRoutes();
      }
      model.picker.setOptions(polzaModelOptions(entry.models), cfg.model);
    } catch {
      model.status.textContent = t('modelsFailed');
    } finally {
      setBusy(model.refresh, false);
    }
  }

  async function loadRoutes() {
    const modelId = cfg.model;
    routeStatus.textContent = '';
    let entry = state.cache.polzaRoutes?.[modelId];
    route.setOptions(routeOptions(fresh(entry) ? entry.list : []), cfg.route);
    if (fresh(entry)) return;
    try {
      entry = { list: await polzaRoutes(modelId), at: Date.now() };
      // keep only lists that are still fresh, so the cache does not grow model by model forever
      const kept = Object.fromEntries(Object.entries(state.cache.polzaRoutes ?? {}).filter(([, e]) => fresh(e)));
      state.cache.polzaRoutes = { ...kept, [modelId]: entry };
      saveCache();
      if (modelId === cfg.model) route.setOptions(routeOptions(entry.list), cfg.route);
    } catch {
      if (modelId === cfg.model) routeStatus.textContent = t('routesFailed');
    }
  }

  const cached = state.cache.polzaModels;
  model.picker.setOptions(cached?.models?.length ? polzaModelOptions(cached.models) : [], cfg.model);
  loadModels();
  loadRoutes();

  return h('div', { class: 'config' }, key.node, model.node, routeNode);
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
  el.clear.addEventListener('click', () => {
    el.source.value = '';
    updateCount();
    scheduleTranslate(0);
    chrome.storage.session.remove('last').catch(() => {});
    el.source.focus();
  });
  el.copy.addEventListener('click', copyOutput);
  // permissions.request must be called right in the click handler, before any await
  el.accessButton.addEventListener('click', () => chrome.permissions.request({ origins: ORIGINS }).then(checkAccess, checkAccess));
  chrome.permissions.onAdded.addListener(checkAccess);
  chrome.permissions.onRemoved.addListener(checkAccess);
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
  checkAccess();

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
