# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Translate+ is a Manifest V3 browser extension for Chromium browsers (Chrome 116+) and Gecko browsers (Firefox 140+). It is plain JavaScript with no build step and no dependencies: `extension/` is the shipped Chromium extension as is, `gecko-extension/` the Firefox one (see "Gecko build" below).

## Commands

```bash
node --test tests/lib.test.mjs                                # offline suite (chunking, in-place batching, providers against a mock server)
node --test --test-name-pattern="gemini" tests/lib.test.mjs   # one test or a group, matched by name
LIVE=1 node --test tests/lib.test.mjs                         # also hits the real Google, Bing and Polza catalog endpoints
node tests/dev-server.mjs                                     # UI harness on http://localhost:5173 (launch.json: "translate-harness")
node tests/dev-server.mjs 5174 gecko-extension                # the same harness for the Firefox folder (launch.json: "translate-harness-gecko")
npx web-ext lint --self-hosted --source-dir gecko-extension   # Mozilla's validator; must report 0 errors
node tools/make-icons.mjs                                     # regenerate extension/icons/icon*.png (copy them to gecko-extension/icons too)
```

Harness pages (served by `tests/dev-server.mjs`, with `tests/chrome-stub.js` standing in for the `chrome` API and returning canned translations):
- `/popup/popup.html`: the popup in a normal tab. Query params read by the stub: `selection=<text>` (simulated page selection), `ui=en|ru`, `reset` (clear stored state), `fail=network|rate|auth`, `latency=<ms>`, `still` (turns off transitions and animations, because a hidden preview pane doesn't advance them), `noaccess` (site access switched off: the Gecko popup shows its notice).
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

`tests/lib.test.mjs` replaces `globalThis.fetch` so that requests to `api.groq.com`, `polza.ai` and `generativelanguage.googleapis.com` go to a local mock server. In each test, `behaviour` decides the mock's reply and `calls` records the requests. Google and Bing are only exercised in `LIVE` mode. The provider tests import `extension/lib/`; they cover the Gecko build because its shared files must be identical (checked by the "gecko build" tests).

### Gecko build

`gecko-extension/` is a copy of `extension/`. The Chromium folder is the base and is not edited for Firefox's sake. Only these files may differ (`GECKO_OWN` in `tests/lib.test.mjs`; every other file must stay byte-identical, line endings aside):
- `manifest.json`: `background.scripts` (an event page; Firefox has no extension service worker), no `minimum_chrome_version`, and `browser_specific_settings.gecko` with the id `translate-plus@neodym121` (never change it: signed builds and updates are tied to it), `strict_min_version` 140 (needed for `data_collection_permissions`), `update_url` pointing at `updates.json` on `main`, and `data_collection_permissions: websiteContent`. Everything else matches the Chromium manifest except `version`: a fix for one browser only ships in that build, so the Firefox version may run ahead.
- `background.js`: `openPopup` works in Firefox without a user gesture but is refused while any panel is open. When that panel is our own popup (`chrome.extension.getViews({type: 'popup'})`), it already took the text from storage, so no standalone window is opened. `keepAlive` is needed there too: without it Firefox stops the event page after 30 idle seconds, in the middle of a slow LLM request.
- `popup/popup.html`, `popup.css`, `popup.js`, `lib/i18n.js`: the site access notice. Firefox lets the user switch an add-on's host access off; the popup checks `chrome.permissions.contains` for `host_permissions` plus the content-script matches and offers `chrome.permissions.request` (called directly in the click handler).
- `popup/dropdown.js`: Firefox fits its toolbar popup to the page after layout changes and fires `resize` without any change in size. The open list closes on `resize` only when the window size really changed; otherwise every list closed the moment it opened. A popup opened as a tab or window (the stub harness, `?window=1`) does not show this, so check dropdowns in the real toolbar popup.

A change to a shared file goes into both folders. A change to one of the files above usually needs the same edit in both, unless it only concerns one browser.

## Conventions

- `README.md` and `README.ru.md` mirror each other; change both together.
- Releases: bump `version` in the manifest(s) of the build(s) that changed, use commit messages like `Translate+ X.Y.Z: <summary>`, and tag `vX.Y.Z` (both builds) or `firefox-vX.Y.Z` (a Firefox-only release). Create the release with `gh release create`. The release marked latest must carry both assets, since the READMEs link to it for both browsers; reattach the unchanged Chromium zip to a Firefox-only release. No CI workflow exists in this repo. Release assets:
  - `translate-plus-chromium.zip`, holding a `translate-plus-chromium/` folder with the contents of `extension/`;
  - `translate-plus-firefox.xpi`, signed by Mozilla (unlisted channel): `npx web-ext sign --channel=unlisted --source-dir gecko-extension --artifacts-dir web-ext-artifacts --ignore-files .amo-upload-uuid` with the AMO API key in `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` (the user sets them; never ask for or type the values). Once the release with the `.xpi` is published, append `{version, update_link}` to `updates.json` (oldest first) and push it; before that, Firefox would be offered a version it cannot download. web-ext leaves `gecko-extension/.amo-upload-uuid` behind (git-ignored, skipped by the tests); AMO refuses a version number it has already signed.
- The popup's look follows the claude.ai style (`popup/tokens.css`). The design reference lives in the git-ignored `стиль/` folder (`DESIGN.md`, tokens); `polza-ai-reference.md` (also git-ignored) has notes on the Polza API.
- The logo geometry exists in three places, which must stay in sync: `extension/icons/logo.svg`, `LOGO` in `content.js`, and `SHAPES` in `tools/make-icons.mjs` (plus the copies in `gecko-extension/`).
