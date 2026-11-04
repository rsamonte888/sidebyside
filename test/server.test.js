import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import {
  rewriteOrigins, rewriteHtmlPaths, rewriteCssPaths, injectAgent, hostAllowed,
  encodeSite, decodeSite, parseProxyPath,
} from '../lib/core.js';
import { createServer } from '../server.js';

test('site encoding round-trips', () => {
  assert.equal(encodeSite('https://www.site.com'), 'www.site.com');
  assert.equal(encodeSite('http://localhost:3000'), 'http:localhost:3000');
  assert.equal(decodeSite('www.site.com'), 'https://www.site.com');
  assert.equal(decodeSite('http:localhost:3000'), 'http://localhost:3000');
  assert.equal(decodeSite('evil.com/../x'), null);
  assert.deepEqual(parseProxyPath('/x/www.site.com/a/b'), {
    site: 'www.site.com', origin: 'https://www.site.com', prefix: '/x/www.site.com', rest: '/a/b',
  });
  assert.equal(parseProxyPath('/x/www.site.com').rest, '/');
  assert.equal(parseProxyPath('/other'), null);
});

test('rewriteOrigins handles absolute, escaped and protocol-relative URLs', () => {
  const base = 'https://sbs.co/x/www.site.com';
  const html = `<a href="https://www.site.com/about">x</a><link href="//www.site.com/a.css">
<script>u="https:\\/\\/www.site.com\\/p"</script><a href="https://www.site.com.au/">o</a>`;
  const out = rewriteOrigins(html, 'https://www.site.com', base);
  assert.match(out, /href="https:\/\/sbs\.co\/x\/www\.site\.com\/about"/);
  assert.match(out, /href="\/\/sbs\.co\/x\/www\.site\.com\/a\.css"/);
  assert.match(out, /"https:\\\/\\\/sbs\.co\\\/x\\\/www\.site\.com\\\/p"/);
  assert.match(out, /https:\/\/www\.site\.com\.au\//);
});

test('rewriteHtmlPaths prefixes root-relative URLs and Nuxt baseURL', () => {
  const P = '/x/www.site.com';
  const html = `<script type="importmap">{"imports":{"#entry":"/_nuxt/a.js"}}</script>
<link rel="modulepreload" href="/_nuxt/a.js"><script type="module" src="/_nuxt/a.js"></script>
<img src="/i.png" srcset="/i.png 1x, /i@2x.png 2x"><a href="//cdn.com/x">c</a><div style="background:url('/bg.jpg')"></div>
<script>window.__NUXT__.config={app:{baseURL:"/",buildAssetsDir:"/_nuxt/"}}</script><meta name="referrer" content="no-referrer">`;
  const out = rewriteHtmlPaths(html, P);
  assert.match(out, /"#entry":"\/x\/www\.site\.com\/_nuxt\/a\.js"/);
  assert.match(out, /href="\/x\/www\.site\.com\/_nuxt\/a\.js"/);
  assert.match(out, /src="\/x\/www\.site\.com\/_nuxt\/a\.js"/);
  assert.match(out, /srcset="\/x\/www\.site\.com\/i\.png 1x, \/x\/www\.site\.com\/i@2x\.png 2x"/);
  assert.match(out, /href="\/\/cdn\.com\/x"/, 'protocol-relative untouched');
  assert.match(out, /url\('\/x\/www\.site\.com\/bg\.jpg'\)/);
  assert.match(out, /baseURL:"\/x\/www\.site\.com\/"/);
  assert.match(out, /buildAssetsDir:"\/_nuxt\/"/, 'assets dir is joined with baseURL by Nuxt');
  assert.doesNotMatch(out, /referrer/);
  assert.equal(rewriteCssPaths('a{background:url(/a.png)}', P), `a{background:url(${P}/a.png)}`);
});

test('injectAgent adds the agent after <head>', () => {
  assert.match(injectAgent('<html><head lang="x"></head></html>'), /<head lang="x"><script src="\/__sbs\/agent.js"><\/script>/);
});

test('hostAllowed supports wildcards', () => {
  const rules = ['*.amplifyapp.com', 'www.site.com'];
  assert.equal(decodeSite('evil.com', rules), null);
  assert.ok(hostAllowed('main.d123.amplifyapp.com', rules));
  assert.ok(hostAllowed('www.site.com', rules));
  assert.ok(!hostAllowed('evil.com', rules));
  assert.ok(!hostAllowed('amplifyapp.com.evil.com', rules));
  assert.ok(hostAllowed('anything.com', []));
});

test('proxy end to end: headers, rewriting, cookies, redirects, referer fallback', async () => {
  const upstream = http.createServer((req, res) => {
    const self = `http://127.0.0.1:${upstream.address().port}`;
    if (req.url === '/redirect') return res.writeHead(301, { location: `${self}/landing` }).end();
    if (req.url === '/api/x') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    const body = zlib.gzipSync(`<html><head></head><body><a href="${self}/x">x</a><img src="/i.png"></body></html>`);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip',
      'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'",
      'set-cookie': ['sid=1; Domain=127.0.0.1; Path=/; Secure; SameSite=None'],
    });
    res.end(body);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => upstream.once('listening', r));
  const site = `http:127.0.0.1:${upstream.address().port}`;

  const app = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const P = `/x/${site}`;

  try {
    const page = await fetch(`${base}${P}/page`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), null);
    assert.equal(page.headers.get('content-security-policy'), null);
    assert.match(html, /<script src="\/__sbs\/agent.js">/);
    assert.ok(html.includes(`href="${base}${P}/x"`));
    assert.ok(html.includes(`src="${P}/i.png"`));
    const cookie = page.headers.getSetCookie()[0];
    assert.doesNotMatch(cookie, /Domain|Secure/i);
    assert.ok(cookie.includes(`Path=${P}/`));

    const redir = await fetch(`${base}${P}/redirect`, { redirect: 'manual' });
    assert.equal(redir.headers.get('location'), `${P}/landing`);

    // fetch('/api/x') from inside a proxied page: routed by Referer
    const api = await fetch(`${base}/api/x`, { headers: { referer: `${base}${P}/page` } });
    assert.deepEqual(await api.json(), { ok: true });
    // a navigation that escaped the prefix is redirected back into it
    const nav = await fetch(`${base}/about`, {
      headers: { referer: `${base}${P}/page`, 'sec-fetch-dest': 'iframe' }, redirect: 'manual',
    });
    assert.equal(nav.headers.get('location'), `${P}/about`);
  } finally {
    upstream.close();
    app.close();
  }
});

test('login flow and static UI', async () => {
  process.env.APP_PASSWORD = 'pw';
  const app = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 200, 'UI is static');
    assert.equal((await fetch(`${base}/__sbs/me`)).status, 401);
    assert.equal((await fetch(`${base}/x/www.site.com/`)).status, 401, 'proxy needs login');
    const bad = await fetch(`${base}/__sbs/login`, { method: 'POST', body: 'password=no', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${base}/__sbs/login`, { method: 'POST', body: 'password=pw', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/__sbs/me`, { headers: { cookie } })).status, 200);
  } finally {
    delete process.env.APP_PASSWORD;
    app.close();
  }
});
