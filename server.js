// Side by Side — compare a live site and a staging (Amplify) build.
//
// Three HTTP listeners:
//   PORT          the comparison UI (public/)
//   LIVE_PORT     reverse proxy for the live site
//   STAGING_PORT  reverse proxy for the staging site
//
// Each proxy serves the target site on its own origin with the *same paths*
// (so Nuxt's router and hydration see the real route), strips headers that
// block framing, rewrites absolute links back to the proxy, and injects a
// small agent script that reports scroll/navigation to the UI via postMessage.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 4000,
  livePort: Number(process.env.LIVE_PORT) || 4001,
  stagingPort: Number(process.env.STAGING_PORT) || 4002,
  // When deployed behind a reverse proxy / subdomains, set the public origins
  // the browser should use for each proxy, e.g. https://live.sbs.example.com
  liveProxyOrigin: process.env.LIVE_PROXY_ORIGIN || '',
  stagingProxyOrigin: process.env.STAGING_PROXY_ORIGIN || '',
  // Comma-separated hostnames the proxy may fetch. Supports "*.amplifyapp.com".
  allowedHosts: (process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

// ---------------------------------------------------------------------------
// helpers

export function hostAllowed(hostname, allowed = config.allowedHosts) {
  if (!allowed.length) return true;
  const h = hostname.toLowerCase();
  return allowed.some((rule) =>
    rule.startsWith('*.') ? h === rule.slice(2) || h.endsWith(rule.slice(1)) : h === rule,
  );
}

export function parseTarget(raw) {
  if (!raw) return { error: 'Missing target URL' };
  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: `Invalid URL: ${raw}` };
  }
  if (!/^https?:$/.test(url.protocol)) return { error: 'Only http(s) URLs are supported' };
  if (!hostAllowed(url.hostname)) return { error: `Host not allowed: ${url.hostname}` };
  return { url };
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function stripOwnCookies(header) {
  return header
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('__sbs_'))
    .join('; ');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripWww = (h) => h.replace(/^www\./i, '');

/** Replace absolute references to the target origin with the proxy origin. */
export function rewriteOrigins(text, targetOrigin, proxyOrigin) {
  const t = new URL(targetOrigin);
  const p = new URL(proxyOrigin);
  const end = '(?![\\w.-])'; // don't match prod.com inside prod.com.au
  const host = escapeRe(t.host);
  return text
    // https://host and http://host
    .replace(new RegExp(`https?://${host}${end}`, 'gi'), p.origin)
    // JSON-escaped: https:\/\/host
    .replace(new RegExp(`https?:\\\\/\\\\/${host}${end}`, 'gi'), p.origin.replace(/\//g, '\\/'))
    // protocol-relative: //host (only after a quote, = , ( or whitespace)
    .replace(new RegExp(`(["'=(\\s])//${host}${end}`, 'gi'), `$1//${p.host}`);
}

export function injectAgent(html) {
  const tag = '<script src="/__sbs/agent.js"></script>';
  // A CSP meta tag would block the agent and is pointless inside the tool.
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'accept-encoding',
]);

const DROP_RESPONSE = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length',
  'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
  'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'clear-site-data', 'alt-svc', 'set-cookie',
]);

const TEXT_TYPES = /text\/html|javascript|json|text\/css|xml/i;

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function errorPage(title, detail) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font:15px/1.5 system-ui,sans-serif;padding:32px;color:#333">
<h2 style="margin:0 0 8px">${esc(title)}</h2><p style="color:#666">${esc(detail)}</p></body>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function proxyOriginFor(req, role) {
  const fixed = role === 'live' ? config.liveProxyOrigin : config.stagingProxyOrigin;
  if (fixed) return fixed.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

// ---------------------------------------------------------------------------
// proxy

export function createProxyHandler(role) {
  const cookieName = `__sbs_${role}`;
  // Fallback for requests that arrive without our cookie (e.g. cookies blocked).
  let lastTarget = null;

  return async function handle(req, res) {
    const reqUrl = new URL(req.url, 'http://placeholder');
    const proxyOrigin = proxyOriginFor(req, role);

    try {
      if (reqUrl.pathname === '/__sbs/agent.js') {
        const js = await readFile(path.join(PUBLIC_DIR, 'agent.js'));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(js);
      }

      if (reqUrl.pathname === '/__sbs/start') {
        const { url, error } = parseTarget(reqUrl.searchParams.get('target'));
        if (error) return send(res, 400, errorPage('Cannot open site', error), 'text/html; charset=utf-8');
        lastTarget = url.origin;
        const secure = proxyOrigin.startsWith('https:');
        res.writeHead(302, {
          'set-cookie': `${cookieName}=${encodeURIComponent(url.origin)}; Path=/; HttpOnly; SameSite=${secure ? 'None; Secure' : 'Lax'}`,
          location: url.pathname + url.search + url.hash,
          'cache-control': 'no-store',
        });
        return res.end();
      }

      let target = readCookie(req, cookieName) || lastTarget;
      if (target && parseTarget(target).error) target = null;
      if (!target) {
        return send(res, 400, errorPage('No site selected', 'Open this proxy from the Side by Side app.'), 'text/html; charset=utf-8');
      }

      await forward(req, res, { target, proxyOrigin, reqUrl });
    } catch (err) {
      console.error(`[${role}] ${req.method} ${req.url}:`, err.message);
      if (!res.headersSent) {
        send(res, 502, errorPage('Could not reach the site', err.cause?.message || err.message), 'text/html; charset=utf-8');
      } else {
        res.destroy();
      }
    }
  };
}

async function forward(req, res, { target, proxyOrigin, reqUrl }) {
  const upstreamUrl = new URL(reqUrl.pathname + reqUrl.search, target);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || key.startsWith('x-forwarded-')) continue;
    let v = Array.isArray(value) ? value.join(', ') : value;
    if (key === 'cookie') {
      v = stripOwnCookies(v);
      if (!v) continue;
    }
    if (key === 'origin') v = target;
    if (key === 'referer') v = v.replace(proxyOrigin, target);
    headers.set(key, v);
  }
  headers.set('accept-encoding', 'gzip, deflate, br');

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: hasBody ? await readBody(req) : undefined,
    redirect: 'manual',
  });

  const out = {};
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE.has(key)) out[key] = value;
  });

  // Cookies: drop Domain so they stick to the proxy host; relax Secure on http.
  const insecure = proxyOrigin.startsWith('http:');
  const cookies = upstream.headers.getSetCookie().map((c) => {
    let v = c.replace(/;\s*domain=[^;]*/gi, '');
    if (insecure) v = v.replace(/;\s*secure/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax');
    return v;
  });
  if (cookies.length) out['set-cookie'] = cookies;

  // Redirects: keep the iframe inside the proxy.
  if (out.location) {
    const loc = new URL(out.location, upstreamUrl);
    if (loc.origin === target) {
      out.location = loc.pathname + loc.search + loc.hash;
    } else if (
      /^https?:$/.test(loc.protocol) &&
      stripWww(loc.hostname) === stripWww(new URL(target).hostname) &&
      hostAllowed(loc.hostname)
    ) {
      // e.g. example.com -> www.example.com: re-target this proxy.
      out.location = `/__sbs/start?target=${encodeURIComponent(loc.href)}`;
    }
  }

  // Hashed Nuxt build assets are safe to cache; everything else isn't, because
  // the same proxy port may point at a different site next time.
  if (!reqUrl.pathname.startsWith('/_nuxt/')) {
    out['cache-control'] = 'no-store';
    delete out.etag;
    delete out['last-modified'];
  }

  const type = upstream.headers.get('content-type') || '';
  if (!upstream.body || req.method === 'HEAD' || [204, 304].includes(upstream.status)) {
    res.writeHead(upstream.status, out);
    return res.end();
  }

  if (TEXT_TYPES.test(type)) {
    let text = rewriteOrigins(await upstream.text(), target, proxyOrigin);
    if (/text\/html/i.test(type)) text = injectAgent(text);
    const buf = Buffer.from(text, 'utf8');
    out['content-length'] = buf.length;
    res.writeHead(upstream.status, out);
    return res.end(buf);
  }

  res.writeHead(upstream.status, out);
  Readable.fromWeb(upstream.body).pipe(res);
}

// ---------------------------------------------------------------------------
// UI server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createUiHandler() {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://placeholder');

    if (url.pathname === '/api/config') {
      const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const hostname = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').replace(/:\d+$/, '');
      return send(res, 200, JSON.stringify({
        live: config.liveProxyOrigin || `${proto}://${hostname}:${config.livePort}`,
        staging: config.stagingProxyOrigin || `${proto}://${hostname}:${config.stagingPort}`,
      }), 'application/json');
    }

    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR + path.sep) || file === 'agent.js') return send(res, 404, 'Not found');
    try {
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      send(res, 404, 'Not found');
    }
  };
}

// ---------------------------------------------------------------------------

function listen(handler, port, label) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, config.host, () => {
      console.log(`  ${label.padEnd(9)} http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`);
      resolve(server);
    });
  });
}

export async function start() {
  console.log('Side by Side');
  const servers = await Promise.all([
    listen(createUiHandler(), config.port, 'App'),
    listen(createProxyHandler('live'), config.livePort, 'Live'),
    listen(createProxyHandler('staging'), config.stagingPort, 'Staging'),
  ]);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.allowedHosts.length) {
    console.warn('\n  WARNING: listening publicly without ALLOWED_HOSTS — this is an open proxy.\n');
  }
  return servers;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start();
}
