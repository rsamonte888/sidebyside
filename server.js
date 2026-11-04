// Side by Side — compare a live site and a staging (Amplify) build.
//
// One HTTP server, one origin:
//   /                       the comparison UI
//   /__sbs/...              UI assets, agent script, login
//   /x/<site>/<path>        reverse proxy: <site>'s <path>
//
// <site> is the target host ("www.example.com" = https, "http:host:port" =
// plain http). Proxied pages are rewritten so they work under the /x/<site>
// prefix: root-relative URLs get the prefix, absolute links back to the site
// point at the proxy, and Nuxt's runtime `app.baseURL` is set to the prefix so
// its router, $fetch and asset loader all stay inside it. Framing headers are
// removed and a small agent script is injected that reports scroll/navigation
// to the UI via postMessage.

import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

export const config = {
  host: process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1'),
  port: Number(process.env.PORT) || 4000,
  // Shared password for the team. Strongly recommended when hosted.
  password: process.env.APP_PASSWORD || '',
  // Comma-separated hostnames the proxy may fetch. Supports "*.amplifyapp.com".
  allowedHosts: parseList(process.env.ALLOWED_HOSTS),
  // Optional: public base URL when the Host header can't be trusted.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
};

function parseList(s) {
  return (s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// sites & URLs

export function hostAllowed(hostname, allowed = config.allowedHosts) {
  if (!allowed.length) return true;
  const h = hostname.toLowerCase();
  return allowed.some((rule) =>
    rule.startsWith('*.') ? h === rule.slice(2) || h.endsWith(rule.slice(1)) : h === rule,
  );
}

/** https://www.a.com -> "www.a.com"; http://localhost:3000 -> "http:localhost:3000" */
export function encodeSite(origin) {
  const u = new URL(origin);
  return (u.protocol === 'http:' ? 'http:' : '') + u.host.toLowerCase();
}

/** Inverse of encodeSite. Returns an origin string or null. */
export function decodeSite(seg) {
  if (!seg) return null;
  let s = decodeURIComponent(seg);
  let proto = 'https:';
  if (s.startsWith('http:')) { proto = 'http:'; s = s.slice(5); }
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(s)) return null;
  const origin = `${proto}//${s.toLowerCase()}`;
  return hostAllowed(new URL(origin).hostname) ? origin : null;
}

const SITE_PREFIX = /^\/x\/([^/]+)(\/.*)?$/;

/** Parse "/x/<site>/rest?q" -> { site, origin, prefix, rest } */
export function parseProxyPath(pathname) {
  const m = SITE_PREFIX.exec(pathname);
  if (!m) return null;
  const origin = decodeSite(m[1]);
  if (!origin) return null;
  return { site: m[1], origin, prefix: `/x/${m[1]}`, rest: m[2] || '/' };
}

// ---------------------------------------------------------------------------
// rewriting

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripWww = (h) => h.replace(/^www\./i, '');

/** Replace absolute references to the target origin with proxyBase (origin + prefix). */
export function rewriteOrigins(text, targetOrigin, proxyBase) {
  const t = new URL(targetOrigin);
  const p = new URL(proxyBase);
  const end = '(?![\\w.-])'; // don't match a.com inside a.com.au
  const host = escapeRe(t.host);
  const protoRel = `//${p.host}${p.pathname.replace(/\/$/, '')}`;
  return text
    .replace(new RegExp(`https?://${host}${end}`, 'gi'), () => proxyBase)
    .replace(new RegExp(`https?:\\\\/\\\\/${host}${end}`, 'gi'), () => proxyBase.replace(/\//g, '\\/'))
    .replace(new RegExp(`(["'=(\\s])//${host}${end}`, 'gi'), (_, c) => c + protoRel);
}

/** Prefix root-relative URLs ("/foo", not "//foo") in HTML. */
export function rewriteHtmlPaths(html, prefix) {
  const P = prefix;
  return html
    // src="/..", href="/..", action, poster, data-src, formaction
    .replace(/(\s(?:src|href|action|poster|data-src|formaction)\s*=\s*["'])\/(?![/\\])/gi, `$1${P}/`)
    // srcset="/a.jpg 1x, /b.jpg 2x"
    .replace(/(\s(?:srcset|data-srcset|imagesrcset)\s*=\s*["'])([^"']*)/gi, (_, a, v) =>
      a + v.replace(/(^|,\s*)\/(?![/\\])/g, `$1${P}/`))
    // url(/..) in inline styles
    .replace(/url\(\s*(["']?)\/(?![/\\])/gi, `url($1${P}/`)
    // <script type="importmap">{"imports":{"#entry":"/_nuxt/x.js"}}
    .replace(/(<script[^>]*type=["']importmap["'][^>]*>)([\s\S]*?)(<\/script>)/gi, (_, a, body, c) =>
      a + body.replace(/:\s*"\/(?!\/)/g, `:"${P}/`) + c)
    // Nuxt 3/4 runtime config: app.baseURL; Nuxt 2: app.basePath / assetsPath
    .replace(/((?:baseURL|basePath|assetsPath)["']?\s*:\s*["'])\/(?!\/)/g, `$1${P}/`)
    // CSP / referrer meta tags would block the agent or our fallback routing
    .replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '')
    .replace(/<meta[^>]+name=["']?referrer["']?[^>]*>/gi, '');
}

export function rewriteCssPaths(css, prefix) {
  return css.replace(/url\(\s*(["']?)\/(?![/\\])/gi, `url($1${prefix}/`);
}

export function injectAgent(html) {
  const tag = '<script src="/__sbs/agent.js"></script>';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
}

// ---------------------------------------------------------------------------
// auth (optional shared password)

const AUTH_COOKIE = '__sbs_auth';
const authToken = () => crypto.createHmac('sha256', config.password).update('sidebyside').digest('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isAuthed(req) {
  if (!config.password) return true;
  const got = readCookie(req, AUTH_COOKIE) || '';
  const want = authToken();
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function loginPage(error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Side by Side</title><link rel="stylesheet" href="/__sbs/ui/styles.css"></head>
<body class="login"><form method="post" action="/__sbs/login" class="login-card">
<h1><span class="dot live"></span><span class="dot staging"></span> Side by Side</h1>
<label>Team password<input type="password" name="password" autofocus required></label>
${error ? '<p class="error">Wrong password</p>' : ''}
<button class="primary" type="submit">Sign in</button></form></body></html>`;
}

// ---------------------------------------------------------------------------
// helpers

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

function errorPage(title, detail) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font:15px/1.5 system-ui,sans-serif;padding:32px;color:#333">
<h2 style="margin:0 0 8px">${esc(title)}</h2><p style="color:#666">${esc(detail)}</p></body>`;
}

async function readBody(req, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function publicOrigin(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// proxy

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding',
]);

const DROP_RESPONSE = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length',
  'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
  'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'clear-site-data', 'alt-svc', 'set-cookie', 'referrer-policy',
  'service-worker-allowed',
]);

const TEXT_TYPES = /text\/html|javascript|json|text\/css|xml/i;

async function proxy(req, res, { origin, prefix, rest, search }) {
  const self = publicOrigin(req);
  const proxyBase = self + prefix;
  const upstreamUrl = new URL(rest + search, origin);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || key.startsWith('x-forwarded-') || key.startsWith('cf-')) continue;
    let v = Array.isArray(value) ? value.join(', ') : value;
    if (key === 'cookie') {
      v = v.split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('__sbs_')).join('; ');
      if (!v) continue;
    }
    if (key === 'origin') v = origin;
    if (key === 'referer') {
      const ref = parseRef(v, self);
      v = ref ? ref.origin + ref.rest : origin + '/';
    }
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

  // Cookies: scope them to this site's prefix so live and staging don't collide.
  const insecure = self.startsWith('http:');
  const cookies = upstream.headers.getSetCookie().map((c) => {
    let v = c.replace(/;\s*domain=[^;]*/gi, '');
    if (/;\s*path=/i.test(v)) v = v.replace(/;\s*path=\/?([^;]*)/i, (_, p) => `; Path=${prefix}/${p}`);
    else v += `; Path=${prefix}/`;
    if (insecure) v = v.replace(/;\s*secure/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax');
    return v;
  });
  if (cookies.length) out['set-cookie'] = cookies;

  // Redirects: keep the frame inside the proxy.
  if (out.location) {
    const loc = new URL(out.location, upstreamUrl);
    const sameSite = loc.origin === origin;
    const sibling = /^https?:$/.test(loc.protocol) &&
      stripWww(loc.hostname) === stripWww(new URL(origin).hostname) && hostAllowed(loc.hostname);
    if (sameSite || sibling) {
      out.location = `/x/${encodeSite(loc.origin)}${loc.pathname}${loc.search}${loc.hash}`;
    }
  }

  // Only hashed Nuxt build assets are safe to cache.
  if (!rest.startsWith('/_nuxt/')) {
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
    let text = rewriteOrigins(await upstream.text(), origin, proxyBase);
    if (/text\/html/i.test(type)) text = injectAgent(rewriteHtmlPaths(text, prefix));
    else if (/text\/css/i.test(type)) text = rewriteCssPaths(text, prefix);
    const buf = Buffer.from(text, 'utf8');
    out['content-length'] = buf.length;
    res.writeHead(upstream.status, out);
    return res.end(buf);
  }

  res.writeHead(upstream.status, out);
  Readable.fromWeb(upstream.body).pipe(res);
}

/** If `referer` is a proxied page on this server, return its parsed site info. */
function parseRef(referer, self) {
  try {
    const u = new URL(referer);
    if (u.origin !== new URL(self).origin) return null;
    const p = parseProxyPath(u.pathname);
    return p && { ...p, rest: p.rest + u.search };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// request handler

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function serveStatic(res, file) {
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found');
  }
}

export function createHandler() {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://placeholder');
    const { pathname, search } = url;
    const secure = publicOrigin(req).startsWith('https:');

    try {
      if (pathname === '/__sbs/health') return send(res, 200, 'ok');
      if (pathname === '/__sbs/ui/styles.css') return serveStatic(res, 'styles.css');

      if (pathname === '/__sbs/login') {
        if (req.method === 'POST') {
          const form = new URLSearchParams((await readBody(req, 10_000)).toString());
          const ok = config.password && form.get('password') === config.password;
          if (!ok) return send(res, 401, loginPage(true), 'text/html; charset=utf-8');
          res.writeHead(303, {
            location: '/',
            'set-cookie': `${AUTH_COOKIE}=${authToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`,
          });
          return res.end();
        }
        return send(res, 200, loginPage(false), 'text/html; charset=utf-8');
      }

      if (!isAuthed(req)) {
        if (pathname === '/') return res.writeHead(303, { location: '/__sbs/login' }).end();
        return send(res, 401, errorPage('Signed out', 'Reload the Side by Side app and sign in.'), 'text/html; charset=utf-8');
      }

      if (pathname === '/__sbs/agent.js') return serveStatic(res, 'agent.js');
      if (pathname === '/__sbs/ui/app.js') return serveStatic(res, 'app.js');
      if (pathname === '/__sbs/logout') {
        return res.writeHead(303, { location: '/', 'set-cookie': `${AUTH_COOKIE}=; Path=/; Max-Age=0` }).end();
      }

      const site = parseProxyPath(pathname);
      if (site) return await proxy(req, res, { ...site, search });
      if (pathname.startsWith('/x/')) {
        return send(res, 403, errorPage('Site not allowed', 'This host is not in ALLOWED_HOSTS.'), 'text/html; charset=utf-8');
      }

      // A root-relative request that escaped the rewriting, e.g. fetch('/api/x')
      // or <img src="/a.png"> rendered client-side. Route it by its Referer.
      const ref = req.headers.referer && parseRef(req.headers.referer, publicOrigin(req));
      if (ref) {
        const dest = req.headers['sec-fetch-dest'];
        if (dest === 'document' || dest === 'iframe') {
          // A navigation: redirect so the frame's URL keeps the prefix.
          return res.writeHead(302, { location: ref.prefix + pathname + search }).end();
        }
        return await proxy(req, res, { ...ref, rest: pathname, search });
      }

      if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
      return send(res, 404, 'Not found');
    } catch (err) {
      console.error(`${req.method} ${req.url}:`, err.message);
      if (!res.headersSent) {
        send(res, 502, errorPage('Could not reach the site', err.cause?.message || err.message), 'text/html; charset=utf-8');
      } else {
        res.destroy();
      }
    }
  };
}

export function start() {
  const server = http.createServer(createHandler());
  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`Side by Side running at http://${shown}:${config.port}`);
    if (!config.password) console.warn('  APP_PASSWORD is not set: anyone who can reach this server can use it.');
    if (!config.allowedHosts.length) console.warn('  ALLOWED_HOSTS is not set: the proxy will fetch any site.');
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start();
}
