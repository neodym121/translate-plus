// node --test tests/            (offline: chunking + LLM providers against a mock server)
// LIVE=1 node --test tests/     (also hits the real Google / Bing endpoints)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitIntoChunks, joinChunks, mapLimit } from '../extension/lib/chunk.js';
import { batchSegments, translateSegments } from '../extension/lib/inplace.js';
import { LANGUAGES, providerLangCode, normalizeLangCode, languageName } from '../extension/lib/languages.js';
import { pickLocale, makeT } from '../extension/lib/i18n.js';
import { loadSettings } from '../extension/lib/settings.js';
import {
  translate, listModels, isTextModel, polzaModels, polzaRoutes, recommendPolzaModel, TranslateError,
} from '../extension/lib/providers.js';

const roundTrip = (text, max) => {
  const chunks = splitIntoChunks(text, max);
  for (const c of chunks) assert.ok(c.text.length <= max, `chunk too long: ${c.text.length}`);
  return joinChunks(chunks, chunks.map((c) => c.text));
};

test('chunking keeps short text untouched', () => {
  assert.equal(roundTrip('Hello world', 100), 'Hello world');
  assert.equal(splitIntoChunks('Hello world', 100).length, 1);
});

test('chunking keeps line breaks and blank lines', () => {
  const text = 'One\nTwo\n\nThree';
  assert.equal(roundTrip(text, 100), text);
  assert.equal(roundTrip(text, 6), text);
});

test('chunking splits a long line at sentence ends', () => {
  const sentence = 'The quick brown fox jumps over the lazy dog. ';
  const text = sentence.repeat(60).trim();
  const chunks = splitIntoChunks(text, 300);
  assert.ok(chunks.length > 5);
  assert.equal(roundTrip(text, 300), text);
});

test('chunking hard-splits unbreakable text', () => {
  const text = 'x'.repeat(2500);
  const chunks = splitIntoChunks(text, 950);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.text.length <= 950));
});

test('chunking works for CJK sentences', () => {
  const text = '今天天气很好。我们去公园玩吧！你觉得怎么样？'.repeat(40);
  assert.equal(roundTrip(text, 100), text);
});

test('mapLimit keeps order and respects the limit', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

test('in place: neighbouring fragments share a request, long and preformatted ones go alone', () => {
  assert.deepEqual(batchSegments(['a', 'b', 'c'], 100), [[0, 1, 2]]);
  assert.deepEqual(batchSegments(['x'.repeat(60), 'y'.repeat(60), 'z'], 100), [[0], [1, 2]]);
  assert.deepEqual(batchSegments(['a', 'code\n\nmore', 'b', 'c'], 100), [[0], [1], [2, 3]]);
  assert.deepEqual(batchSegments([], 100), []);
});

test('in place: a batch is split back by blank lines', async () => {
  const calls = [];
  const out = await translateSegments(['One.', 'Two.', 'Three.'], async (text) => {
    calls.push(text);
    return text.toUpperCase().replace(/\n\n/g, '\n \n'); // services may put spaces into blank lines
  });
  assert.deepEqual(out, ['ONE.', 'TWO.', 'THREE.']);
  assert.deepEqual(calls, ['One.\n\nTwo.\n\nThree.']);
});

test('in place: when paragraphs come back merged, each fragment is translated alone', async () => {
  const calls = [];
  const out = await translateSegments(['One.', 'Two.'], async (text) => {
    calls.push(text);
    return text.includes('\n') ? 'ONE. TWO.' : `[${text}]`;
  });
  assert.deepEqual(out, ['[One.]', '[Two.]']);
  assert.equal(calls.length, 3);
});

test('in place: errors reach the caller', async () => {
  await assert.rejects(translateSegments(['a'], async () => { throw new TranslateError('rate'); }), { code: 'rate' });
});

test('language helpers', () => {
  assert.equal(providerLangCode('google', 'zh-Hans'), 'zh-CN');
  assert.equal(providerLangCode('bing', 'sr'), 'sr-Cyrl');
  assert.equal(providerLangCode('groq', 'de'), 'de');
  assert.equal(normalizeLangCode('iw'), 'he');
  assert.equal(normalizeLangCode('zh-CN'), 'zh-Hans');
  assert.equal(normalizeLangCode('en-US'), 'en');
  assert.equal(languageName('de', 'ru'), 'Немецкий');
  assert.equal(languageName('de', 'en'), 'German');
  assert.equal(new Set(LANGUAGES).size, LANGUAGES.length, 'duplicate language codes');
});

test('interface language: English unless Russian is picked', () => {
  assert.equal(pickLocale(undefined), 'en');
  assert.equal(pickLocale('ru'), 'ru');
  assert.equal(pickLocale('de'), 'en');
  assert.equal(pickLocale('toString'), 'en');
  assert.equal(makeT('en')('uiLanguage'), 'Interface language');
  assert.equal(makeT('ru')('uiLanguage'), 'Язык интерфейса');
  assert.equal(makeT('ru')('modelsUpdated', { n: 3 }), 'Список обновлён · моделей: 3');
});

test('settings default to English for both the interface and the translation', async () => {
  const saved = globalThis.chrome;
  let stored = {};
  globalThis.chrome = { storage: { local: { get: async () => stored } } };
  try {
    const fresh = await loadSettings();
    assert.equal(fresh.uiLang, 'en');
    assert.equal(fresh.targetLang, 'en');
    assert.equal(fresh.polza.model, 'qwen/qwen3.5-9b');
    assert.equal(fresh.polza.route, ''); // Polza picks the sub-provider
    stored = { settings: { uiLang: 'ru', targetLang: 'de' } };
    const kept = await loadSettings();
    assert.equal(kept.uiLang, 'ru');
    assert.equal(kept.targetLang, 'de');
  } finally {
    globalThis.chrome = saved;
  }
});

// ------------------------------------------------------------- mock LLM backends

let server;
let calls;
let behaviour;
const realFetch = globalThis.fetch;
let routeToMock = true;

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const entry = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      calls.push(entry);
      const reply = behaviour(entry);
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // Route the provider hosts to the mock; Bing needs a User-Agent that Node does not send.
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (routeToMock && ['api.groq.com', 'polza.ai', 'generativelanguage.googleapis.com'].includes(url.host)) {
      return realFetch(`http://127.0.0.1:${port}/${url.host}${url.pathname}${url.search}`, init);
    }
    if (url.host.endsWith('bing.com')) {
      const headers = new Headers(init.headers);
      headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0');
      return realFetch(input, { ...init, headers });
    }
    return realFetch(input, init);
  };
});

test.after(() => {
  globalThis.fetch = realFetch;
  server.close();
});

const settings = {
  groq: { apiKey: 'gsk_test', model: 'llama-3.3-70b-versatile' },
  polza: { apiKey: 'pza_test', model: 'openai/gpt-4o-mini' },
  gemini: { apiKey: 'AIza_test', model: 'gemini-flash-latest' },
};
const ask = (provider, extra = {}) => translate({ provider, text: 'Hello', target: 'ru', settings, ...extra });
const chatReply = (content) => ({ json: { choices: [{ message: { role: 'assistant', content } }] } });

test('groq: request shape and answer', async () => {
  calls = [];
  behaviour = () => chatReply('Привет');
  const out = await ask('groq');
  assert.equal(out.text, 'Привет');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api.groq.com/openai/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer gsk_test');
  assert.equal(calls[0].body.model, 'llama-3.3-70b-versatile');
  assert.equal(calls[0].body.messages[1].content, 'Hello');
  assert.match(calls[0].body.messages[0].content, /into Russian/);
});

test('polza: request shape, reasoning tags stripped', async () => {
  calls = [];
  behaviour = () => chatReply('<think>hmm</think>\nПривет\n');
  const out = await ask('polza');
  assert.equal(out.text, 'Привет');
  assert.equal(calls[0].url, '/polza.ai/api/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer pza_test');
  assert.equal(calls[0].body.model, 'openai/gpt-4o-mini');
  assert.equal(calls[0].body.provider, undefined); // no sub-provider picked: Polza decides
});

test('polza: a picked sub-provider is the only one allowed', async () => {
  calls = [];
  behaviour = () => chatReply('Привет');
  await ask('polza', { settings: { ...settings, polza: { ...settings.polza, route: 'deepinfra/turbo' } } });
  assert.deepEqual(calls[0].body.provider, { only: ['deepinfra/turbo'] });
});

test('llm: retries without temperature when the model rejects it', async () => {
  calls = [];
  behaviour = (c) => (c.body.temperature !== undefined
    ? { status: 400, json: { error: { message: "Unsupported value: 'temperature' does not support 0.2" } } }
    : chatReply('Привет'));
  const out = await ask('polza');
  assert.equal(out.text, 'Привет');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.temperature, undefined);
});

test('llm: error mapping', async () => {
  const cases = [
    [401, 'auth'], [403, 'auth'], [402, 'balance'], [429, 'rate'], [404, 'model'], [503, 'server'], [400, 'http'],
  ];
  for (const [status, code] of cases) {
    behaviour = () => ({ status, json: { error: { code: 'x', message: 'boom' } } });
    await assert.rejects(ask('polza'), (e) => e instanceof TranslateError && e.code === code && e.detail === 'boom', `status ${status}`);
  }
});

test('llm: missing key is reported before any request', async () => {
  calls = [];
  await assert.rejects(
    translate({ provider: 'groq', text: 'Hi', target: 'ru', settings: { groq: { apiKey: '', model: 'm' } } }),
    (e) => e.code === 'no_key',
  );
  assert.equal(calls.length, 0);
});

test('gemini: request shape and answer', async () => {
  calls = [];
  behaviour = () => ({ json: { candidates: [{ content: { parts: [{ text: 'Привет' }] }, finishReason: 'STOP' }] } });
  const out = await ask('gemini');
  assert.equal(out.text, 'Привет');
  assert.equal(calls[0].url, '/generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
  assert.equal(calls[0].headers['x-goog-api-key'], 'AIza_test');
  assert.equal(calls[0].body.contents[0].parts[0].text, 'Hello');
  assert.match(calls[0].body.systemInstruction.parts[0].text, /into Russian/);
});

test('gemini: skips thought parts, reports blocks', async () => {
  behaviour = () => ({ json: { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'Привет' }] } }] } });
  assert.equal((await ask('gemini')).text, 'Привет');

  behaviour = () => ({ json: { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] } });
  await assert.rejects(ask('gemini'), (e) => e.code === 'blocked');

  behaviour = () => ({ status: 400, json: { error: { message: 'API key not valid. Please pass a valid API key.' } } });
  await assert.rejects(ask('gemini'), (e) => e.code === 'auth');
});

test('isTextModel: keeps models that take and give text, drops speech / image / embedding / safety models', () => {
  const keep = [
    'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-3.5-flash', 'gemma-3-27b-it', 'gemma-3n-e4b-it',
    'learnlm-2.0-flash-experimental', 'gemini-robotics-er-1.5-preview', 'gemini-2.5-flash-preview-09-2025',
    'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'meta-llama/llama-4-scout-17b-16e-instruct',
    'moonshotai/kimi-k2-instruct-0905', 'qwen/qwen3-32b', 'groq/compound', 'allam-2-7b', 'deepseek-r1-distill-llama-70b',
  ];
  const drop = [
    'whisper-large-v3', 'whisper-large-v3-turbo', 'distil-whisper-large-v3-en', 'playai-tts', 'playai-tts-arabic',
    'canopylabs/orpheus-v1-english', 'meta-llama/llama-guard-4-12b', 'meta-llama/llama-prompt-guard-2-86m',
    'openai/gpt-oss-safeguard-20b', 'gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-2.5-flash-preview-tts',
    'gemini-embedding-001', 'text-embedding-004', 'aqa', 'imagen-4.0-generate-001', 'veo-3.0-generate-001',
    'gemini-2.5-flash-native-audio-preview-09-2025', 'gemini-2.5-computer-use-preview-10-2025',
  ];
  assert.deepEqual(keep.filter((id) => !isTextModel({}, id)), []);
  assert.deepEqual(drop.filter((id) => isTextModel({}, id)), []);
});

test('isTextModel: modality tags, when an API provides them, decide before the name does', () => {
  assert.equal(isTextModel({ input_modalities: ['audio'], output_modalities: ['text'] }, 'looks-like-chat'), false);
  assert.equal(isTextModel({ architecture: { output_modalities: ['image'] } }, 'looks-like-chat'), false);
  assert.equal(isTextModel({ inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'] }, 'gemini-x'), true);
  assert.equal(isTextModel({ displayName: 'Gemini 2.5 Flash Preview TTS' }, 'gemini-x', 'Gemini 2.5 Flash Preview TTS'), false);
});

test('model list: groq keeps text models, groups them by developer, hides retired and non-text ones', async () => {
  const m = (id, owned_by, active = true) => ({ id, owned_by, active });
  behaviour = () => ({ json: { object: 'list', data: [
    m('openai/gpt-oss-20b', 'OpenAI'), m('whisper-large-v3', 'OpenAI'), m('llama-3.3-70b-versatile', 'Meta'),
    m('playai-tts', 'PlayAI'), m('meta-llama/llama-guard-4-12b', 'Meta'), m('qwen/qwen3-32b', 'Alibaba Cloud'),
    m('llama-3.1-8b-instant', 'Meta'), m('retired-model', 'Meta', false), m('mystery', ''),
  ] } });
  assert.deepEqual(await listModels('groq', 'k'), [
    { id: 'qwen/qwen3-32b', group: 'Alibaba Cloud' },
    { id: 'llama-3.1-8b-instant', group: 'Meta' },
    { id: 'llama-3.3-70b-versatile', group: 'Meta' },
    { id: 'openai/gpt-oss-20b', group: 'OpenAI' },
    { id: 'mystery', group: '' },
  ]);
});

test('model list: gemini goes by the generateContent tag, keeps Gemma, groups by family, newest first', async () => {
  const m = (name, methods = ['generateContent', 'countTokens'], displayName) => ({ name: `models/${name}`, displayName, supportedGenerationMethods: methods });
  const pages = [
    { models: [m('gemini-2.5-flash'), m('gemini-2.5-flash-image', ['generateContent'], 'Nano Banana'), m('gemma-3-27b-it'), m('gemini-embedding-001', ['embedContent'])], nextPageToken: 'p2' },
    { models: [m('gemini-3.5-flash'), m('gemini-flash-latest'), m('gemini-live-2.5-flash', ['bidiGenerateContent']), m('gemini-2.5-flash-preview-tts', ['generateContent']),
      m('imagen-4.0-generate-001', ['predict']), m('learnlm-2.0-flash-experimental'), m('gemma-3n-e4b-it'), m('gemini-2.5-pro')] },
  ];
  calls = [];
  behaviour = (c) => ({ json: pages[c.url.includes('pageToken=p2') ? 1 : 0] });
  assert.deepEqual(await listModels('gemini', 'k'), [
    { id: 'gemini-flash-latest', group: 'Gemini' },
    { id: 'gemini-3.5-flash', group: 'Gemini' },
    { id: 'gemini-2.5-pro', group: 'Gemini' },
    { id: 'gemini-2.5-flash', group: 'Gemini' },
    { id: 'gemma-3n-e4b-it', group: 'Gemma' },
    { id: 'gemma-3-27b-it', group: 'Gemma' },
    { id: 'learnlm-2.0-flash-experimental', group: 'LearnLM' },
  ]);
  assert.equal(calls.length, 2, 'both pages are requested');
  assert.equal(calls[0].headers['x-goog-api-key'], 'k');
});

test('gemini: a model that refuses a system instruction (Gemma) gets the rules inside the message', async () => {
  calls = [];
  behaviour = (c) => (c.body.systemInstruction
    ? { status: 400, json: { error: { message: 'Developer instruction is not enabled for models/gemma-3-27b-it' } } }
    : { json: { candidates: [{ content: { parts: [{ text: 'Привет' }] }, finishReason: 'STOP' }] } });
  const out = await translate({ provider: 'gemini', text: 'Hello', target: 'ru', settings: { gemini: { apiKey: 'k', model: 'gemma-3-27b-it' } } });
  assert.equal(out.text, 'Привет');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.systemInstruction, undefined);
  assert.match(calls[1].body.contents[0].parts[0].text, /into Russian[\s\S]*Text to translate:\nHello$/);
});

test('polza catalog: every developer\'s text models, page by page, and a recommendation', async () => {
  const arch = (input, output) => ({ input_modalities: input, output_modalities: output });
  behaviour = (c) => {
    assert.doesNotMatch(c.url, /providers=/); // one list for all developers
    const page = Number(/page=(\d+)/.exec(c.url)[1]);
    return { json: { data: page === 1
      ? [
        { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', task_tags: ['чат', 'рассуждения'], architecture: arch(['text', 'image'], ['text']), top_provider: { pricing: { prompt_per_million: '149' } } },
        { id: 'openai/gpt-4o-mini-tts', name: 'OpenAI: TTS', architecture: arch(['text'], ['audio']) },
      ]
      : [
        { id: 'anthropic/claude-haiku', name: 'Anthropic: Claude Haiku', task_tags: ['чат', 'дешёвая', 'быстрая'], architecture: arch(['text'], ['text']), top_provider: { pricing: { prompt_per_million: '17' } } },
        { id: 'openai/whisper-1', name: 'Whisper', architecture: arch(['audio'], ['text']) },
      ],
    meta: { totalPages: 2 } } };
  };
  const models = await polzaModels();
  assert.deepEqual(models.map((m) => [m.id, m.vendor]), [['openai/gpt-5', 'openai'], ['anthropic/claude-haiku', 'anthropic']]);
  assert.equal(recommendPolzaModel(models).id, 'anthropic/claude-haiku');
});

test('polza sub-providers: the services that run one model, cheapest first', async () => {
  calls = [];
  behaviour = () => ({ json: { id: 'meta-llama/llama-3.3-70b-instruct', providers: [
    { name: 'Cerebras', pricing: { prompt_per_million: '101.6', completion_per_million: '143.5' } },
    { name: 'deepinfra/turbo', pricing: { prompt_per_million: '11.9', completion_per_million: '38.2' } },
    { name: '' },
  ] } });
  const routes = await polzaRoutes('meta-llama/llama-3.3-70b-instruct');
  assert.equal(calls[0].url, '/polza.ai/api/v1/models/meta-llama/llama-3.3-70b-instruct');
  assert.deepEqual(routes, [
    { name: 'deepinfra/turbo', prompt: 11.9, completion: 38.2 },
    { name: 'Cerebras', prompt: 101.6, completion: 143.5 },
  ]);
});

// ------------------------------------------------------------------ gecko build

const ROOT = new URL('../', import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, ROOT), 'utf8'));

// The files of gecko-extension/ that are meant to differ from extension/; the rest are plain copies.
const GECKO_OWN = new Set([
  'manifest.json', 'background.js', 'lib/i18n.js', 'popup/popup.html', 'popup/popup.css', 'popup/popup.js', 'popup/dropdown.js',
]);

/** -1, 0 or 1 for dotted version numbers such as 1.2.10 and 1.2.9. */
const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
};

async function listFiles(dir) {
  const base = fileURLToPath(new URL(dir, ROOT));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name !== '.amo-upload-uuid') // left by web-ext sign
    .map((e) => relative(base, join(e.parentPath, e.name)).replaceAll('\\', '/')).sort();
}

test('gecko build: Firefox manifest, in step with the Chromium one and with updates.json', async () => {
  const [chromium, gecko, updates] = await Promise.all([
    readJson('extension/manifest.json'), readJson('gecko-extension/manifest.json'), readJson('updates.json'),
  ]);
  assert.deepEqual(gecko.background, { scripts: ['background.js'], type: 'module' });
  const { id, strict_min_version: min, update_url: updateUrl, data_collection_permissions: data } = gecko.browser_specific_settings.gecko;
  assert.equal(id, 'translate-plus@neodym121'); // fixed for good once a build is signed
  assert.ok(Number.parseFloat(min) >= 140, 'data_collection_permissions needs Firefox 140+');
  assert.deepEqual(data.required, ['websiteContent']);
  assert.equal(updateUrl, 'https://raw.githubusercontent.com/neodym121/translate-plus/main/updates.json');

  // Apart from the browser-specific keys, both builds declare the same permissions and content script.
  // The versions may differ: a fix for one browser only ships in that build.
  const common = ({ version, background, minimum_chrome_version, browser_specific_settings, ...rest }) => rest;
  assert.deepEqual(common(gecko), common(chromium));

  // Every released Firefox version is listed with its own release asset, oldest first. The manifest
  // carries the newest one, or the next one while it waits to be signed and released.
  const list = updates.addons[id]?.updates ?? [];
  assert.ok(list.length, 'updates.json lists no version');
  for (const [i, u] of list.entries()) {
    assert.match(u.update_link, new RegExp(`/releases/download/[\\w-]*v${u.version.replaceAll('.', '\\.')}/translate-plus-firefox\\.xpi$`));
    if (i) assert.equal(compareVersions(list[i - 1].version, u.version), -1, 'updates.json is not in version order');
  }
  assert.ok(compareVersions(gecko.version, list.at(-1).version) >= 0, 'the manifest is older than the last released version');
});

test('gecko build: shared files are plain copies of extension/', async () => {
  const [chromium, gecko] = await Promise.all([listFiles('extension/'), listFiles('gecko-extension/')]);
  assert.deepEqual(gecko, chromium, 'the two folders hold different files');
  const text = (file, buf) => (/\.(png|woff2)$/.test(file) ? buf : Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n')));
  const drifted = [];
  for (const file of chromium) {
    if (GECKO_OWN.has(file)) continue;
    const [a, b] = await Promise.all([readFile(new URL(`extension/${file}`, ROOT)), readFile(new URL(`gecko-extension/${file}`, ROOT))]);
    if (!text(file, a).equals(text(file, b))) drifted.push(file);
  }
  assert.deepEqual(drifted, [], 'changed in one folder only: carry the change over to the other');
});

test('gecko build: the site access notice speaks both languages', async () => {
  const { makeT: geckoT } = await import('../gecko-extension/lib/i18n.js');
  for (const key of ['accessMissing', 'accessAllow']) {
    assert.notEqual(geckoT('en')(key), key);
    assert.notEqual(geckoT('ru')(key), geckoT('en')(key));
  }
});

// ---------------------------------------------------------------- live services

const live = process.env.LIVE ? test : test.skip;

live('google: translates, keeps line breaks, reports the source language', async () => {
  const out = await translate({ provider: 'google', text: 'Hello world!\nSecond line.\n\nThird paragraph.', target: 'ru', settings });
  assert.equal(out.text.split('\n').length, 4);
  assert.match(out.text, /Привет/);
  assert.equal(out.detected, 'en');
});

live('bing: translates, keeps line breaks, reports the source language', async () => {
  const out = await translate({ provider: 'bing', text: 'Hello world!\nSecond line.\n\nThird paragraph.', target: 'ru', settings });
  assert.equal(out.text.split('\n').length, 4);
  assert.match(out.text, /Привет/);
  assert.equal(out.detected, 'en');
});

live('google + bing: long text goes through in chunks', async () => {
  const text = Array.from({ length: 90 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ');
  for (const provider of ['google', 'bing']) {
    const out = await translate({ provider, text, target: 'de', settings });
    assert.ok(out.text.length > text.length * 0.6, `${provider}: result too short (${out.text.length})`);
    assert.match(out.text, /90/, `${provider}: last sentence missing`);
  }
});

live('google + bing: every language in the list is accepted', async () => {
  // Google throttles bursts hard, so it gets a slow lane; Bing is fine with a quick one.
  const lane = async (provider, pause) => {
    const failures = [];
    for (const code of LANGUAGES) {
      await new Promise((r) => setTimeout(r, pause));
      try {
        const out = await translate({ provider, text: 'Good morning, how are you?', target: code, settings });
        if (!out.text.trim() || (code !== 'en' && out.text === 'Good morning, how are you?')) failures.push(`${provider}/${code}: unchanged`);
      } catch (e) {
        failures.push(`${provider}/${code}: ${e.code} ${String(e.detail).slice(0, 60)}`);
      }
    }
    return failures;
  };
  const [g, b] = await Promise.all([lane('google', 2500), lane('bing', 150)]);
  assert.deepEqual([...g, ...b], []);
});

live('polza: public catalog is reachable', async () => {
  routeToMock = false;
  try {
    const models = await polzaModels();
    assert.ok(models.length > 100);
    assert.ok(models.some((m) => m.id === 'openai/gpt-4o-mini'));
    assert.ok(models.some((m) => m.id === 'qwen/qwen3.5-9b')); // the default model
    const routes = await polzaRoutes('openai/gpt-4o-mini');
    assert.ok(routes.length > 0 && routes.every((r) => r.name));
  } finally {
    routeToMock = true;
  }
});
