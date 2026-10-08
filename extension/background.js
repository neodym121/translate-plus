// Receives the selected text from the in-page icon and brings the translator up.
//
// The text travels through chrome.storage.session: the popup reads it as soon
// as it opens. Chrome 127+ can open the toolbar popup from here; if that is
// refused (older Chrome, a browser that lacks the API), the same popup page is
// opened in a small standalone window instead.

const PENDING_KEY = 'pending';
const WINDOW_KEY = 'translatorWindowId';
const WINDOW_URL = 'popup/popup.html?window=1';

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'translate-selection' || typeof message.text !== 'string') return;
  openTranslator(message.text, sender.tab?.windowId).catch((e) => console.warn('Translate+:', e));
});

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
