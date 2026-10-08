# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Translate+ is a Manifest V3 browser extension for Chromium browsers (Chrome 116+). It is plain JavaScript with no build step and no dependencies: `extension/` is the shipped extension as is.

## Commands

```bash
node --test tests/lib.test.mjs                                # offline suite (chunking, in-place batching, providers against a mock server)
node --test --test-name-pattern="gemini" tests/lib.test.mjs   # one test or a group, matched by name
LIVE=1 node --test tests/lib.test.mjs                         # also hits the real Google, Bing and Polza catalog endpoints
node tests/dev-server.mjs                                     # UI harness on http://localhost:5173 (launch.json: "translate-harness")
node tools/make-icons.mjs                                     # regenerate extension/icons/icon*.png
```

Harness pages (served by `tests/dev-server.mjs`, with `tests/chrome-stub.js` standing in for the `chrome` API and returning canned translations):
- `/popup/popup.html`: the popup in a normal tab. Query params read by the stub: `selection=<text>` (simulated page selection), `ui=en|ru`, `reset` (clear stored state), `fail=network|rate|auth`, `latency=<ms>`, `still` (turns off transitions and animations, because a hidden preview pane doesn't advance them).
- `/__page`: a test page with the content script, for the selection icon and in-place translation.
- `/__shots?lang=ru&zoom=2`: the README screenshot layout (main screen and settings side by side).

## Architecture

Three runtime contexts, sharing ES modules from `extension/lib/`:

- **`content.js`**: a classic script injected into every page and frame. It cannot import modules, so it duplicates some things on purpose: its own en/ru `STRINGS`, the inlined logo SVG, and `IN_PLACE_MAX` (the same limit is in `background.js`). It shows the logo at the end of a selection inside a shadow-DOM host. A click sends `{type: 'translate-selection'}`. A Shift+click collects page fragments (paragraphs, list items, cells, or a text field/contenteditable range), sends `{type: 'translate-in-place', texts}`, replaces the originals with the translations, and keeps its own undo stack for Ctrl+Z.
- **`background.js`** (module service worker): for `translate-selection` it writes `pending` to `chrome.storage.session` and opens the toolbar popup with `chrome.action.openPopup`. If that call fails, it opens `popup/popup.html?window=1` as a standalone window and reuses that window afterwards. For `translate-in-place` it translates via `lib/inplace.js` and keeps itself alive during long LLM calls.
- **`popup/popup.js`**: the translator UI plus settings. Incoming text comes, in order of preference, from `pending` (15 s TTL), then from the active tab's selection via `chrome.scripting.executeScript`, then from the restored `last` session. Text that came from a page puts the popup in "selection mode", which shows only the translation. `popup/dropdown.js` is the searchable dropdown used for languages, models and Polza sub-providers.

Shared library (`extension/lib/`):
- **`providers.js`**: every provider exposes the same call, `translate({provider, text, target, settings, signal}) -> {text, detected}`. Failures throw `TranslateError` with a `code` (`auth`, `rate`, `balance`, `model`, `no_key`, `timeout`, ...), which `i18n.errorMessage` turns into localized text.
  - Google and Bing use keyless web endpoints and split long text with `chunk.js`. Bing scrapes a page token, which is cached in `chrome.storage.session` through `configureCache`.
  - Groq and Polza go through the OpenAI-compatible `openAiChat`; Gemini has its own request shape. All three share `systemPrompt`.
  - Model lists come from each provider's API and are filtered by `isTextModel`. The Polza catalog and sub-provider routes are public endpoints and need no key. `recommendPolzaModel` scores Polza's Russian `task_tags` strings, so keep those literals as they are.
- **`inplace.js`**: batches neighbouring fragments into roughly 3000-character requests separated by blank lines. If a service returns a different number of paragraphs, that batch falls back to one request per fragment.
- **`settings.js`**: `DEFAULT_SETTINGS`, merged one level deep with the saved `settings` key in `chrome.storage.local`.
- **`i18n.js`**: all popup strings, in English and Russian. Every new string needs both.

Storage keys: `chrome.storage.local` holds `settings` and `modelCache`; `chrome.storage.session` holds `pending`, `last`, `bingAuth` and `translatorWindowId`. `popup/theme.js` mirrors the theme setting into `localStorage` so the popup doesn't flash light before its stylesheet loads.

Adding a provider touches `PROVIDERS` and `IMPLEMENTATIONS` in `providers.js`, `DEFAULT_SETTINGS`, `host_permissions` in `manifest.json`, the popup settings rendering, i18n strings, and the provider table in both READMEs.

### Tests

`tests/lib.test.mjs` replaces `globalThis.fetch` so that requests to `api.groq.com`, `polza.ai` and `generativelanguage.googleapis.com` go to a local mock server. In each test, `behaviour` decides the mock's reply and `calls` records the requests. Google and Bing are only exercised in `LIVE` mode.

## Conventions

- `README.md` and `README.ru.md` mirror each other; change both together.
- Releases: bump `version` in `extension/manifest.json`, use commit messages like `Translate+ X.Y.Z: <summary>`, and tag `vX.Y.Z`. The release asset is `translate-plus-chromium.zip`, holding a `translate-plus-chromium/` folder with the contents of `extension/`. No CI workflow exists in this repo.
- The popup's look follows the claude.ai style (`popup/tokens.css`). The design reference lives in the git-ignored `стиль/` folder (`DESIGN.md`, tokens); `polza-ai-reference.md` (also git-ignored) has notes on the Polza API.
- The logo geometry exists in three places, which must stay in sync: `extension/icons/logo.svg`, `LOGO` in `content.js`, and `SHAPES` in `tools/make-icons.mjs`.
