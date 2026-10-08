// In-memory stand-in for the parts of the `chrome` API the extension uses, plus
// canned answers for the translation services. Only for tests/dev-server.mjs.
(() => {
  const params = new URLSearchParams(location.search);
  const listeners = [];

  const store = (name, backend) => {
    const read = () => { try { return JSON.parse(backend.getItem(`stub.${name}`) ?? '{}'); } catch { return {}; } };
    const write = (data) => backend.setItem(`stub.${name}`, JSON.stringify(data));
    const emit = (changes) => listeners.forEach((fn) => fn(changes, name));
    return {
      async get(keys) {
        const data = read();
        if (keys == null) return data;
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
      },
      async set(items) {
        const data = read();
        const changes = {};
        for (const [k, v] of Object.entries(items)) { changes[k] = { oldValue: data[k], newValue: v }; data[k] = v; }
        write(data);
        emit(changes);
      },
      async remove(keys) {
        const data = read();
        const changes = {};
        for (const k of [].concat(keys)) { if (k in data) { changes[k] = { oldValue: data[k] }; delete data[k]; } }
        write(data);
        emit(changes);
      },
    };
  };

  if (params.has('reset')) { localStorage.clear(); sessionStorage.clear(); }

  window.__messages = [];
  window.chrome = {
    storage: {
      local: store('local', localStorage),
      session: store('session', sessionStorage),
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    i18n: {
      getUILanguage: () => params.get('ui') ?? 'ru',
      detectLanguage: async (text) => ({
        isReliable: true,
        languages: [{ language: /[а-яё]/i.test(text) ? 'ru' : /[一-鿿]/.test(text) ? 'zh' : 'en', percentage: 100 }],
      }),
    },
    tabs: { query: async () => [{ id: 1 }] },
    scripting: { executeScript: async () => [{ frameId: 0, result: params.get('selection') ?? '' }] },
    runtime: {
      id: 'translate-plus-stub',
      getURL: (p) => p,
      sendMessage: async (message) => {
        window.__messages.push(message);
        if (message?.type !== 'translate-in-place') return undefined;
        // What background.js does for an Alt+click, with the canned services below.
        const [{ translateSegments }, { translate }, { loadSettings }] = await Promise.all([
          import('/lib/inplace.js'), import('/lib/providers.js'), import('/lib/settings.js'),
        ]);
        const settings = await loadSettings();
        try {
          const texts = await translateSegments(message.texts, async (text) => (await translate({
            provider: settings.provider, text, target: settings.targetLang, settings,
          })).text);
          return { texts };
        } catch (e) {
          return { error: `Could not translate (${e.code ?? e.message})` };
        }
      },
    },
    action: {},
    windows: {},
  };

  // ?still=1 freezes transitions: a hidden test pane does not advance them, real browsers do.
  if (params.has('still')) {
    const freeze = document.createElement('style');
    freeze.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
    document.documentElement.appendChild(freeze);
  }

  // -------------------------------------------------------- canned services
  const realFetch = window.fetch.bind(window);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const bodyOf = (init) => (init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(init?.body ?? '{}'));
  const fail = params.get('fail');

  // Real translations of the sample texts the README screenshots use (tests/screenshots.html).
  const DEMO = {
    'Die beste Zeit, einen Baum zu pflanzen, war vor zwanzig Jahren. Die zweitbeste Zeit ist jetzt.': {
      from: 'de', en: 'The best time to plant a tree was twenty years ago. The second best time is now.',
    },
    'The best time to plant a tree was twenty years ago. The second best time is now.': {
      from: 'en', ru: 'Лучшее время посадить дерево было двадцать лет назад. Следующее лучшее время — сейчас.',
    },
  };

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const host = url.host;
    await delay(Number(params.get('latency') ?? 450));

    if (fail === 'network') throw new TypeError('Failed to fetch');
    if (host === 'translate.googleapis.com') {
      if (fail === 'rate') return new Response('<html>Sorry...</html>', { status: 429 });
      const q = bodyOf(init).q;
      const demo = DEMO[q]?.[url.searchParams.get('tl')];
      if (demo) return json([[[demo, q, null, null, 10]], null, DEMO[q].from]);
      const tagged = q.replace(/^(?=\S)/gm, `[${url.searchParams.get('tl')}] `); // every paragraph, like a real answer
      return json([[[tagged, q, null, null, 10]], null, /[а-яё]/i.test(q) ? 'ru' : 'en']);
    }
    if (host === 'www.bing.com' && url.pathname === '/translator') {
      return new Response('IG:"ABCDEF0123456789" var params_AbusePreventionHelper = [1791403440713,"tok_demo",3600]; data-iid="translator.5023"');
    }
    if (host === 'www.bing.com') {
      const body = bodyOf(init);
      return json([{ translations: [{ text: `(bing→${body.to}) ${body.text}`, to: body.to }], detectedLanguage: { language: 'en' } }]);
    }
    if (host === 'polza.ai' && url.pathname.startsWith('/api/v1/models')) { // catalog and one model's sub-providers
      return realFetch(`/__proxy?url=${encodeURIComponent(url.href)}`);
    }
    if (host === 'api.groq.com' && url.pathname.endsWith('/models')) {
      const m = (id, owned_by, active = true) => ({ id, object: 'model', owned_by, active });
      return json({ object: 'list', data: [
        m('llama-3.3-70b-versatile', 'Meta'), m('llama-3.1-8b-instant', 'Meta'), m('meta-llama/llama-4-scout-17b-16e-instruct', 'Meta'),
        m('openai/gpt-oss-120b', 'OpenAI'), m('openai/gpt-oss-20b', 'OpenAI'), m('qwen/qwen3-32b', 'Alibaba Cloud'),
        m('moonshotai/kimi-k2-instruct-0905', 'Moonshot AI'), m('groq/compound', 'Groq'), m('groq/compound-mini', 'Groq'),
        // none of these can translate: speech in, speech out, safety verdicts, retired
        m('whisper-large-v3', 'OpenAI'), m('whisper-large-v3-turbo', 'OpenAI'), m('playai-tts', 'PlayAI'),
        m('meta-llama/llama-guard-4-12b', 'Meta'), m('openai/gpt-oss-safeguard-20b', 'OpenAI'), m('retired-model', 'Meta', false),
      ] });
    }
    if (host === 'generativelanguage.googleapis.com' && url.pathname.endsWith('/models')) {
      const m = (name, methods = ['generateContent', 'countTokens'], displayName) => ({ name: `models/${name}`, displayName, supportedGenerationMethods: methods });
      return json({ models: [
        m('gemini-2.5-flash'), m('gemini-2.5-pro'), m('gemini-flash-latest'), m('gemini-flash-lite-latest'), m('gemini-3.5-flash'),
        m('gemini-2.5-flash-lite'), m('gemma-3-27b-it'), m('gemma-3n-e4b-it'), m('learnlm-2.0-flash-experimental'),
        // none of these answer in text
        m('gemini-2.5-flash-image', ['generateContent'], 'Nano Banana'), m('gemini-2.5-flash-preview-tts', ['generateContent']),
        m('gemini-embedding-001', ['embedContent']), m('gemini-live-2.5-flash-preview', ['bidiGenerateContent']),
        m('imagen-4.0-generate-001', ['predict']), m('veo-3.0-generate-001', ['predictLongRunning']),
      ] });
    }
    if (host === 'api.groq.com' || host === 'polza.ai') {
      if (fail === 'auth') return json({ error: { message: 'Invalid API key' } }, 401);
      const body = bodyOf(init);
      return json({ choices: [{ message: { content: `[${host}] ${body.messages.at(-1).content}` } }] });
    }
    if (host === 'generativelanguage.googleapis.com') {
      const body = bodyOf(init);
      return json({ candidates: [{ content: { parts: [{ text: `[gemini] ${body.contents[0].parts[0].text}` }] }, finishReason: 'STOP' }] });
    }
    return realFetch(input, init);
  };
})();
