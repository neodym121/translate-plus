// Local harness for looking at the extension UI in an ordinary browser tab.
// Serves extension/ and injects tests/chrome-stub.js (an in-memory `chrome` API
// with canned translations) into the popup page and into tests/page.html.
//
//   node tests/dev-server.mjs [port]
//   http://localhost:5173/popup/popup.html?selection=Hello%20world
//   http://localhost:5173/__page
//   http://localhost:5173/__shots?lang=ru   (README screenshot: main screen and settings side by side; &zoom=2 for a sharp capture)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..', 'extension');
const PORT = Number(process.argv[2] ?? 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2',
};

async function send(res, file, transform) {
  try {
    let body = await readFile(file);
    if (transform) body = Buffer.from(transform(body.toString('utf8')));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/__stub.js') return send(res, join(HERE, 'chrome-stub.js'));
  if (url.pathname === '/__shots') return send(res, join(HERE, 'screenshots.html'));
  if (url.pathname === '/__page') {
    return send(res, join(HERE, 'page.html'), (html) => html.replace('<!--STUB-->', '<script src="/__stub.js"></script>'));
  }
  if (url.pathname === '/__proxy') { // real, public GET requests (Polza catalog) without CORS trouble
    try {
      const upstream = await fetch(url.searchParams.get('url'), { headers: { 'Accept-Language': 'en' } });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      return res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.writeHead(502);
      return res.end(String(e));
    }
  }

  const path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = join(EXT, path);
  if (!file.startsWith(EXT)) { res.writeHead(403); return res.end(); }
  if (path.endsWith('popup.html')) {
    return send(res, file, (html) => html.replace('<script type="module"', '<script src="/__stub.js"></script>\n  <script type="module"'));
  }
  return send(res, file);
}).listen(PORT, () => console.log(`Translate+ harness on http://localhost:${PORT}`));
