// Side by Side — request handling shared by the Netlify Function and the local
// dev server. Uses only web-standard Request/Response/fetch.
//
// Routes handled here (the UI itself is static files in public/):
//   /__sbs/health, /__sbs/me, /__sbs/login, /__sbs/logout
//   /x/<site>/<path>     reverse proxy: <site>'s <path>
//   anything else        a root-relative request that escaped from a proxied
//                        page (e.g. fetch('/api/x')), routed by its Referer
//
// <site> is the target host ("www.example.com" = https, "http:host:port" =
// plain http). Proxied pages are rewritten so they work under the /x/<site>
// prefix: root-relative URLs get the prefix, absolute links back to the site
// point at the proxy, and Nuxt's runtime `app.baseURL` is set to the prefix so
// its router, $fetch and asset loader stay inside it. Framing headers are
// removed and a small agent script is injected that reports scroll/navigation
// to the UI via postMessage.

import crypto from 'node:crypto';

export function getConfig(env = process.env) {
  return {
    password: env.APP_PASSWORD || '',
    allowedHosts: (env.ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  };
}

// ---------------------------------------------------------------------------
// sites & URLs

export function hostAllowed(hostname, allowed = getConfig().allowedHosts) {
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

/** Inverse of encodeSite. Returns an origin string, or null if invalid/not allowed. */
export function decodeSite(seg, allowed) {
  if (!seg) return null;
  let s;
  try { s = decodeURIComponent(seg); } catch { return null; }
  let proto = 'https:';
  if (s.startsWith('http:')) { proto = 'http:'; s = s.slice(5); }
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(s)) return null;
  const origin = `${proto}//${s.toLowerCase()}`;
  return hostAllowed(new URL(origin).hostname, allowed) ? origin : null;
}

const SITE_PREFIX = /^\/x\/([^/]+)(\/.*)?$/;

/** "/x/<site>/rest" -> { site, origin, prefix, rest } */
export function parseProxyPath(pathname, allowed) {
  const m = SITE_PREFIX.exec(pathname);
  if (!m) return null;
  const origin = decodeSite(m[1], allowed);
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
    // CSP / referrer meta tags would block the agent or the Referer routing
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
// auth (shared team password)

const AUTH_COOKIE = '__sbs_auth';
const authToken = (password) => crypto.createHmac('sha256', password).update('sidebyside').digest('hex');

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isAuthed(request, cfg) {
  if (!cfg.password) return true;
  const got = readCookie(request, AUTH_COOKIE) || '';
  const want = authToken(cfg.password);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** Only same-site paths, so the login can't be used to redirect elsewhere. */
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

function loginPage(error, next) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Side by Side</title><link rel="stylesheet" href="/__sbs/ui/styles.css"></head>
<body class="login"><form method="post" action="/__sbs/login" class="login-card">
<h1><span class="dot live"></span><span class="dot staging"></span> Side by Side</h1>
<input type="hidden" name="next" value="${esc(safeNext(next))}">
<label>Team password<input type="password" name="password" autofocus required></label>
${error ? '<p class="error">Wrong password</p>' : ''}
<button class="primary" type="submit">Sign in</button></form></body></html>`;
}

// ---------------------------------------------------------------------------
// responses

const NO_STORE = { 'cache-control': 'no-store' };

function text(status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  return new Response(body, { status, headers: { 'content-type': type, ...NO_STORE, ...extra } });
}

function html(status, body, extra) {
  return text(status, body, 'text/html; charset=utf-8', extra);
}

function redirect(status, location, extra = {}) {
  return new Response(null, { status, headers: { location, ...NO_STORE, ...extra } });
}

function errorPage(status, title, detail) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return html(status, `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font:15px/1.5 system-ui,sans-serif;padding:32px;color:#333">
<h2 style="margin:0 0 8px">${esc(title)}</h2><p style="color:#666">${esc(detail)}</p></body>`);
}

// ---------------------------------------------------------------------------
// proxy

const DROP_REQUEST = new Set([
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

/** If `referer` is a proxied page on this app, return its parsed site info. */
function parseRef(referer, selfOrigin, allowed) {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    if (u.origin !== selfOrigin) return null;
    const p = parseProxyPath(u.pathname, allowed);
    return p && { ...p, rest: p.rest + u.search };
  } catch {
    return null;
  }
}

async function proxy(request, { origin, prefix, rest, search, self, allowed, viaReferer }) {
  const proxyBase = self + prefix;
  const upstreamUrl = new URL(rest + search, origin);

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (DROP_REQUEST.has(key) || key.startsWith('x-forwarded-') || key.startsWith('x-nf-') ||
        key.startsWith('cf-') || key === 'x-real-ip' || key === 'client-ip') continue;
    let v = value;
    if (key === 'cookie') {
      v = v.split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('__sbs_')).join('; ');
      if (!v) continue;
    }
    if (key === 'origin') v = origin;
    if (key === 'referer') {
      const ref = parseRef(v, self, allowed);
      v = ref ? ref.origin + ref.rest : origin + '/';
    }
    headers.set(key, v);
  }
  headers.set('accept-encoding', 'gzip, deflate, br');

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
  });

  const out = new Headers();
  for (const [key, value] of upstream.headers) {
    if (!DROP_RESPONSE.has(key)) out.set(key, value);
  }

  // Cookies: scope them to this site's prefix so live and staging don't collide.
  const insecure = self.startsWith('http:');
  for (const c of upstream.headers.getSetCookie()) {
    let v = c.replace(/;\s*domain=[^;]*/gi, '');
    if (/;\s*path=/i.test(v)) v = v.replace(/;\s*path=\/?([^;]*)/i, (_, p) => `; Path=${prefix}/${p}`);
    else v += `; Path=${prefix}/`;
    if (insecure) v = v.replace(/;\s*secure/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax');
    out.append('set-cookie', v);
  }

  // Redirects: keep the frame inside the proxy.
  const location = out.get('location');
  if (location) {
    const loc = new URL(location, upstreamUrl);
    const sibling = /^https?:$/.test(loc.protocol) &&
      stripWww(loc.hostname) === stripWww(new URL(origin).hostname) && hostAllowed(loc.hostname, allowed);
    if (loc.origin === origin || sibling) {
      out.set('location', `/x/${encodeSite(loc.origin)}${loc.pathname}${loc.search}${loc.hash}`);
    }
  }

  // Only hashed build assets under the /x/<site>/ prefix are safe to cache:
  // Referer-routed URLs look the same for every site, so never cache those.
  if (viaReferer || !rest.startsWith('/_nuxt/')) {
    out.set('cache-control', 'no-store');
    out.delete('etag');
    out.delete('last-modified');
  }
  if (viaReferer) out.set('vary', 'Referer');

  const type = upstream.headers.get('content-type') || '';
  const status = upstream.status;
  if (!upstream.body || request.method === 'HEAD' || [204, 304].includes(status)) {
    return new Response(null, { status, headers: out });
  }

  if (TEXT_TYPES.test(type)) {
    let body = rewriteOrigins(await upstream.text(), origin, proxyBase);
    if (/text\/html/i.test(type)) body = injectAgent(rewriteHtmlPaths(body, prefix));
    else if (/text\/css/i.test(type)) body = rewriteCssPaths(body, prefix);
    return new Response(body, { status, headers: out });
  }

  return new Response(upstream.body, { status, headers: out });
}

// ---------------------------------------------------------------------------
// entry point

export async function handle(request, env = process.env) {
  const cfg = getConfig(env);
  const url = new URL(request.url);
  const { pathname, search } = url;
  const self = cfg.publicUrl || url.origin;
  const secure = self.startsWith('https:');

  try {
    if (pathname === '/__sbs/health') return text(200, 'ok');

    if (pathname === '/__sbs/login') {
      if (request.method === 'POST') {
        const form = new URLSearchParams(await request.text());
        const next = safeNext(form.get('next'));
        if (!cfg.password || form.get('password') !== cfg.password) return html(401, loginPage(true, next));
        return redirect(303, next, {
          'set-cookie': `${AUTH_COOKIE}=${authToken(cfg.password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`,
        });
      }
      return html(200, loginPage(false, url.searchParams.get('next')));
    }

    if (pathname === '/__sbs/logout') {
      return redirect(303, '/', { 'set-cookie': `${AUTH_COOKIE}=; Path=/; Max-Age=0` });
    }

    if (!isAuthed(request, cfg)) {
      if (pathname === '/__sbs/me') return text(401, 'signed out');
      return errorPage(401, 'Signed out', 'Reload the Side by Side app and sign in.');
    }

    if (pathname === '/__sbs/me') return text(200, 'ok');

    const site = parseProxyPath(pathname, cfg.allowedHosts);
    if (site) return await proxy(request, { ...site, search, self, allowed: cfg.allowedHosts });
    if (pathname.startsWith('/x/')) {
      return errorPage(403, 'Site not allowed', 'This host is not in ALLOWED_HOSTS.');
    }

    // A root-relative request that escaped the rewriting, e.g. fetch('/api/x')
    // or <img src="/a.png"> rendered client-side. Route it by its Referer.
    const ref = parseRef(request.headers.get('referer'), self, cfg.allowedHosts);
    if (ref) {
      const dest = request.headers.get('sec-fetch-dest');
      if (dest === 'document' || dest === 'iframe') {
        // A navigation: redirect so the frame's URL keeps the prefix.
        return redirect(302, ref.prefix + pathname + search);
      }
      return await proxy(request, { ...ref, rest: pathname, search, self, allowed: cfg.allowedHosts, viaReferer: true });
    }

    return text(404, 'Not found');
  } catch (err) {
    console.error(`${request.method} ${request.url}:`, err.message);
    return errorPage(502, 'Could not reach the site', err.cause?.message || err.message);
  }
}
