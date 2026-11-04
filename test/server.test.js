import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { rewriteOrigins, injectAgent, hostAllowed, parseTarget, createProxyHandler } from '../server.js';

test('rewriteOrigins replaces absolute, escaped and protocol-relative URLs', () => {
  const html = `<a href="https://www.site.com/about">x</a>
<link href="//www.site.com/a.css">
<script>window.__NUXT__={url:"https:\\/\\/www.site.com\\/p"}</script>
<a href="https://www.site.com.au/">other</a>`;
  const out = rewriteOrigins(html, 'https://www.site.com', 'http://localhost:4001');
  assert.match(out, /href="http:\/\/localhost:4001\/about"/);
  assert.match(out, /href="\/\/localhost:4001\/a.css"/);
  assert.match(out, /"http:\\\/\\\/localhost:4001\\\/p"/);
  assert.match(out, /https:\/\/www\.site\.com\.au\//, 'must not touch a different domain');
});

test('injectAgent adds the agent after <head> and strips CSP meta', () => {
  const out = injectAgent('<html><head lang="x"><meta http-equiv="Content-Security-Policy" content="frame-ancestors none"></head></html>');
  assert.match(out, /<head lang="x"><script src="\/__sbs\/agent.js"><\/script>/);
  assert.doesNotMatch(out, /Content-Security-Policy/);
});

test('hostAllowed supports wildcards', () => {
  const rules = ['*.amplifyapp.com', 'www.site.com'];
  assert.ok(hostAllowed('main.d123.amplifyapp.com', rules));
  assert.ok(hostAllowed('www.site.com', rules));
  assert.ok(!hostAllowed('evil.com', rules));
  assert.ok(!hostAllowed('amplifyapp.com.evil.com', rules));
  assert.ok(hostAllowed('anything.com', []));
});

test('parseTarget adds https and rejects non-http', () => {
  assert.equal(parseTarget('site.com/x').url.href, 'https://site.com/x');
  assert.ok(parseTarget('ftp://site.com').error);
});

test('proxy strips framing headers, rewrites HTML, keeps cookies on proxy host', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(301, { location: `http://127.0.0.1:${upstream.address().port}/landing` });
      return res.end();
    }
    const body = zlib.gzipSync(`<html><head><title>t</title></head><body><a href="http://127.0.0.1:${upstream.address().port}/x">x</a></body></html>`);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
      'set-cookie': ['sid=1; Domain=127.0.0.1; Path=/; Secure; SameSite=None'],
    });
    res.end(body);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => upstream.once('listening', r));
  const target = `http://127.0.0.1:${upstream.address().port}`;

  const proxy = http.createServer(createProxyHandler('live')).listen(0, '127.0.0.1');
  await new Promise((r) => proxy.once('listening', r));
  const p = `http://127.0.0.1:${proxy.address().port}`;

  try {
    const start = await fetch(`${p}/__sbs/start?target=${encodeURIComponent(target + '/page')}`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    assert.equal(start.headers.get('location'), '/page');
    const cookie = start.headers.get('set-cookie').split(';')[0];

    const page = await fetch(`${p}/page`, { headers: { cookie } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), null);
    assert.equal(page.headers.get('content-security-policy'), null);
    assert.match(html, /<script src="\/__sbs\/agent.js">/);
    assert.match(html, new RegExp(`href="${p}/x"`));
    const sc = page.headers.getSetCookie()[0];
    assert.doesNotMatch(sc, /Domain/i);
    assert.doesNotMatch(sc, /Secure/i);

    const redir = await fetch(`${p}/redirect`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(redir.headers.get('location'), '/landing');
  } finally {
    upstream.close();
    proxy.close();
  }
});
