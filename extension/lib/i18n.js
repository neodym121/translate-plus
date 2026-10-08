// Interface strings: English (the default) and Russian, switched in Settings -> Language.

const STRINGS = {
  ru: {
    settings: 'Настройки',
    back: 'Назад',
    detectAuto: 'Автоопределение',
    targetLabel: 'Язык перевода',
    sourcePlaceholder: 'Введите текст или выделите его на странице',
    resultEmpty: 'Перевод появится здесь',
    translating: 'Перевожу…',
    copy: 'Копировать',
    copied: 'Скопировано',
    clear: 'Очистить',
    retry: 'Повторить',
    openSettings: 'Открыть настройки',
    truncated: 'Текст обрезан до {n} символов',

    providerSection: 'Провайдер перевода',
    providerFree: 'Бесплатно, без ключа',
    providerNeedsKey: 'Нужен API-ключ',
    providerKeySet: 'API-ключ сконфигурирован',
    apiKey: 'API-ключ',
    getKey: 'Получить ключ',
    showKey: 'Показать ключ',
    hideKey: 'Скрыть ключ',
    model: 'Модель',
    subprovider: 'Субпровайдер',
    subproviderHint: 'Сервис, на котором работает выбранная модель',
    routeAuto: 'Автоматически',
    routeAutoNote: 'Polza сама выберет доступный сервис',
    routePrice: 'вход {in} ₽ · выход {out} ₽ за 1M токенов',
    routesFailed: 'Не удалось загрузить субпровайдеров модели',
    search: 'Поиск',
    noMatches: 'Ничего не найдено',
    refreshModels: 'Обновить список моделей',
    modelsUpdated: 'Список обновлён · моделей: {n}',
    modelsFailed: 'Не удалось загрузить список',
    modelsNeedKey: 'Сначала введите API-ключ',
    otherModels: 'Другие',
    languageSection: 'Язык',
    uiLanguage: 'Язык интерфейса',
    uiLanguageNote: 'Меню, кнопки и подписи',
    appearanceSection: 'Оформление',
    darkTheme: 'Тёмная тема',
    darkThemeNote: 'Тёмное оформление окна',
    pageSection: 'На странице',
    showIcon: 'Значок при выделении текста',
    showIconNote: 'Маленький логотип рядом с выделенным текстом. Shift+клик по нему — перевод прямо на странице',

    errNoKey: 'Для {name} нужен API-ключ. Добавьте его в настройках.',
    errAuth: '{name} не принял ключ. Проверьте API-ключ в настройках.',
    errBalance: 'Недостаточно средств на балансе {name}.',
    errRate: 'Слишком много запросов к {name}. Подождите немного и повторите.',
    errNetwork: 'Нет связи с {name}. Проверьте интернет.',
    errTimeout: '{name} слишком долго не отвечает.',
    errServer: 'Сервис {name} сейчас недоступен.',
    errModel: 'Модель не найдена. Выберите другую в настройках.',
    errBlocked: '{name} отказался переводить этот текст.',
    errBad: '{name} вернул неожиданный ответ.',
    errGeneric: 'Не удалось перевести: {detail}',
  },
  en: {
    settings: 'Settings',
    back: 'Back',
    detectAuto: 'Auto-detect',
    targetLabel: 'Translate to',
    sourcePlaceholder: 'Type text, or select it on a page',
    resultEmpty: 'The translation will appear here',
    translating: 'Translating…',
    copy: 'Copy',
    copied: 'Copied',
    clear: 'Clear',
    retry: 'Try again',
    openSettings: 'Open settings',
    truncated: 'Text was cut to {n} characters',

    providerSection: 'Translation provider',
    providerFree: 'Free, no key needed',
    providerNeedsKey: 'API key required',
    providerKeySet: 'API key configured',
    apiKey: 'API key',
    getKey: 'Get a key',
    showKey: 'Show key',
    hideKey: 'Hide key',
    model: 'Model',
    subprovider: 'Sub-provider',
    subproviderHint: 'The service that runs the chosen model',
    routeAuto: 'Automatic',
    routeAutoNote: 'Polza picks an available service',
    routePrice: 'in {in} ₽ · out {out} ₽ per 1M tokens',
    routesFailed: 'Could not load the sub-providers of this model',
    search: 'Search',
    noMatches: 'Nothing found',
    refreshModels: 'Refresh model list',
    modelsUpdated: 'List updated · {n} models',
    modelsFailed: 'Could not load the list',
    modelsNeedKey: 'Enter the API key first',
    otherModels: 'Other',
    languageSection: 'Language',
    uiLanguage: 'Interface language',
    uiLanguageNote: 'Menus, buttons and labels',
    appearanceSection: 'Appearance',
    darkTheme: 'Dark theme',
    darkThemeNote: 'A dark look for the window',
    pageSection: 'On pages',
    showIcon: 'Icon on text selection',
    showIconNote: 'A small logo next to the selected text. Shift+click it to translate right on the page',

    errNoKey: '{name} needs an API key. Add it in the settings.',
    errAuth: '{name} rejected the key. Check the API key in the settings.',
    errBalance: 'Not enough balance on {name}.',
    errRate: 'Too many requests to {name}. Wait a moment and try again.',
    errNetwork: 'Cannot reach {name}. Check your connection.',
    errTimeout: '{name} is taking too long to answer.',
    errServer: '{name} is unavailable right now.',
    errModel: 'Model not found. Pick another one in the settings.',
    errBlocked: '{name} refused to translate this text.',
    errBad: '{name} returned an unexpected answer.',
    errGeneric: 'Could not translate: {detail}',
  },
};

/** The interface language saved in the settings; English when it is unset or unknown. */
export function pickLocale(code) {
  return Object.hasOwn(STRINGS, code ?? '') ? code : 'en';
}

export function makeT(locale) {
  const table = STRINGS[locale] ?? STRINGS.en;
  return (key, vars = {}) => (table[key] ?? STRINGS.en[key] ?? key)
    .replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

const ERROR_KEYS = {
  no_key: 'errNoKey',
  auth: 'errAuth',
  balance: 'errBalance',
  rate: 'errRate',
  network: 'errNetwork',
  timeout: 'errTimeout',
  server: 'errServer',
  model: 'errModel',
  blocked: 'errBlocked',
  bad_response: 'errBad',
};

export function errorMessage(t, error, providerName) {
  const key = ERROR_KEYS[error?.code];
  if (key) return t(key, { name: providerName });
  return t('errGeneric', { detail: error?.detail || error?.message || String(error) });
}
