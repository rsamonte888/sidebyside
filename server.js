// Local dev server for Side by Side. In production this runs on Netlify:
// public/ is served by the CDN and everything else goes to
// netlify/functions/proxy.mjs. This file mimics that setup with node:http.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './lib/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** Static files win, like Netlify with preferStatic. */
async function tryStatic(pathname, res) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (file !== 'index.html' && !file.startsWith('__sbs/')) return false;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return false;
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function nodeToRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const url = `http://${req.headers.host || `localhost:${PORT}`}${req.url}`;
  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

async function writeResponse(response, res) {
  const headers = {};
  for (const [k, v] of response.headers) if (k !== 'set-cookie') headers[k] = v;
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (await tryStatic(pathname, res)) return;
      await writeResponse(await handle(await nodeToRequest(req)), res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end('Internal error');
      else res.destroy();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Side by Side running at http://${HOST}:${PORT}`);
    if (!process.env.APP_PASSWORD) console.warn('  APP_PASSWORD is not set: no sign-in required.');
    if (!process.env.ALLOWED_HOSTS) console.warn('  ALLOWED_HOSTS is not set: the proxy will fetch any site.');
  });
}
