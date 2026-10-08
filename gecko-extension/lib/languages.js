// Canonical language codes follow Bing (BCP-47). Google and the LLM providers
// get their own spelling through `GOOGLE_CODE`.

export const LANGUAGES = [
  'af', 'sq', 'am', 'ar', 'hy', 'az', 'eu', 'be', 'bn', 'bs', 'bg', 'ca', 'zh-Hans', 'zh-Hant',
  'hr', 'cs', 'da', 'nl', 'en', 'et', 'fil', 'fi', 'fr', 'gl', 'ka', 'de', 'el', 'gu', 'he', 'hi',
  'hu', 'is', 'id', 'ga', 'it', 'ja', 'kn', 'kk', 'km', 'ko', 'ky', 'lo', 'lv', 'lt', 'mk', 'ms',
  'ml', 'mt', 'mr', 'mn', 'ne', 'nb', 'fa', 'pl', 'pt', 'pa', 'ro', 'ru', 'sr', 'sk', 'sl', 'es',
  'sw', 'sv', 'ta', 'tt', 'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'cy',
];

const GOOGLE_CODE = {
  'zh-Hans': 'zh-CN',
  'zh-Hant': 'zh-TW',
  he: 'iw',
  nb: 'no',
  fil: 'tl',
};

const BING_CODE = {
  sr: 'sr-Cyrl',
  mn: 'mn-Cyrl',
};

export function providerLangCode(provider, code) {
  if (provider === 'google') return GOOGLE_CODE[code] ?? code;
  if (provider === 'bing') return BING_CODE[code] ?? code;
  return code;
}

// Codes that detectors return -> the canonical code used in LANGUAGES.
const ALIASES = {
  iw: 'he', no: 'nb', tl: 'fil', jw: 'jv',
  zh: 'zh-Hans', 'zh-cn': 'zh-Hans', 'zh-sg': 'zh-Hans', 'zh-tw': 'zh-Hant', 'zh-hk': 'zh-Hant',
  'sr-cyrl': 'sr', 'sr-latn': 'sr', 'mn-cyrl': 'mn', 'pt-br': 'pt', 'pt-pt': 'pt',
};

export function normalizeLangCode(code) {
  if (!code) return null;
  const lower = String(code).toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  const found = LANGUAGES.find((c) => c.toLowerCase() === lower);
  if (found) return found;
  return lower.split('-')[0];
}

const namers = new Map();

/** Language name in `locale`, e.g. languageName('de', 'ru') -> "немецкий". */
export function languageName(code, locale = 'en') {
  let namer = namers.get(locale);
  if (!namer) {
    try {
      namer = new Intl.DisplayNames([locale], { type: 'language' });
    } catch {
      namer = { of: (c) => c };
    }
    namers.set(locale, namer);
  }
  let name;
  try {
    name = namer.of(code);
  } catch {
    name = code;
  }
  if (!name || name === code) return code;
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
}
