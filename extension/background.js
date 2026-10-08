// Two jobs for the in-page icon:
//
// - A click brings the translator up with the selected text. The text travels
//   through chrome.storage.session: the popup reads it as soon as it opens.
//   Chrome 127+ can open the toolbar popup from here; if that is refused (older
//   Chrome, a browser that lacks the API), the same popup page is opened in a
//   small standalone window instead.
// - A Shift+click translates the selection right here and hands the translation
//   back to the page, which puts it where the original text was.
import { loadSettings } from './lib/settings.js';
import { PROVIDERS, translate, configureCache } from './lib/providers.js';
import { translateSegments } from './lib/inplace.js';
import { makeT, pickLocale, errorMessage } from './lib/i18n.js';

const PENDING_KEY = 'pending';
const WINDOW_KEY = 'translatorWindowId';
const WINDOW_URL = 'popup/popup.html?window=1';
const IN_PLACE_MAX = 20000; // characters; the page checks the same limit before asking

configureCache({
  get: async (key) => (await chrome.storage.session.get(key))[key],
  set: (key, value) => chrome.storage.session.set({ [key]: value }),
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'translate-selection' && typeof message.text === 'string') {
    openTranslator(message.text, sender.tab?.windowId).catch((e) => console.warn('Translate+:', e));
    return undefined;
  }
  if (message?.type === 'translate-in-place' && Array.isArray(message.texts)) {
    translateInPlace(message.texts.map(String)).then(sendResponse);
    return true; // the answer comes asynchronously
  }
  return undefined;
});

// ------------------------------------------------------------ in-place

async function translateInPlace(texts) {
  const settings = await loadSettings();
  const provider = PROVIDERS[settings.provider] ? settings.provider : 'google';
  const t = makeT(pickLocale(settings.uiLang));
  if (texts.reduce((n, s) => n + s.length, 0) > IN_PLACE_MAX) return { error: 'too long' };
  try {
    const translated = await keepAlive(translateSegments(texts, async (text) => {
      const out = await translate({ provider, text, target: settings.targetLang, settings });
      return out.text;
    }));
    return { texts: translated };
  } catch (error) {
    return { error: errorMessage(t, error, PROVIDERS[provider].name) };
  }
}

/** An AI model can take longer than the 30 s a quiet service worker is allowed to live. */
async function keepAlive(promise) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20e3);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

// ----------------------------------------------------------- translator

async function openTranslator(text, windowId) {
  await chrome.storage.session.set({ [PENDING_KEY]: { text, at: Date.now() } });

  // A standalone translator window that is already open just takes the new text.
  const existing = await findTranslatorWindow();
  if (existing) {
    await chrome.windows.update(existing, { focused: true });
    return;
  }

  try {
    await chrome.action.openPopup(windowId ? { windowId } : undefined);
  } catch {
    await openWindow();
  }
}

async function findTranslatorWindow() {
  const { [WINDOW_KEY]: id } = await chrome.storage.session.get(WINDOW_KEY);
  if (id === undefined) return null;
  try {
    await chrome.windows.get(id);
    return id;
  } catch {
    await chrome.storage.session.remove(WINDOW_KEY);
    return null;
  }
}

async function openWindow() {
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(WINDOW_URL),
    type: 'popup',
    width: 440,
    height: 620,
    focused: true,
  });
  await chrome.storage.session.set({ [WINDOW_KEY]: win.id });
}
