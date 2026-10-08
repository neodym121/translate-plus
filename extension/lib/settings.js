export const DEFAULT_MODELS = {
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  gemini: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
};

export const DEFAULT_SETTINGS = {
  provider: 'google',
  uiLang: 'en',
  targetLang: 'en',
  showIcon: true,
  theme: 'light',
  groq: { apiKey: '', model: 'llama-3.3-70b-versatile' },
  gemini: { apiKey: '', model: 'gemini-flash-latest' },
  polza: { apiKey: '', model: 'anthropic/claude-haiku-5.5', route: '' }, // route: the sub-provider, '' = Polza picks
};

function merge(base, saved) {
  const out = { ...base };
  for (const key of Object.keys(base)) {
    const value = saved?.[key];
    if (value === undefined || value === null) continue;
    out[key] = typeof base[key] === 'object' && base[key] !== null ? { ...base[key], ...value } : value;
  }
  return out;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return merge(DEFAULT_SETTINGS, settings);
}

export function saveSettings(settings) {
  return chrome.storage.local.set({ settings });
}
