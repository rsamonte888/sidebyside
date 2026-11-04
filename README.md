# Side by Side

A QA tool for comparing a **production** page with a new **Amplify** build of the same page. Both sites load next to each other and stay in sync:

- **Synced scrolling.** Scroll either side and the other follows. You can sync *by pixel* (same offset) or *by percent* (same relative position, useful when page heights differ).
- **Synced navigation.** Click a link on either side and the other goes to the same path. For Nuxt (2, 3 and 4) this uses the app's own router, so there's no full reload.
- **Viewport presets.** Fit, 1920, 1440, 1280, 1024, 768, 390 and 360. Wide viewports are scaled down to fit the pane.
- **Layouts.** Side by side, stacked, or **overlay** with a staging-opacity slider and a **Difference** mode. In Difference mode identical pixels turn black, so changes stand out.
- **Shareable links.** *Copy link* captures both URLs, the path, the viewport and the layout, so QA can send an exact comparison in a ticket.

Nothing has to change on your website.

## Quick start

Requires Node 18.17 or newer. There are no dependencies to install.

```bash
npm start
```

Open http://localhost:4000 and enter:

| Field   | Example                                  |
|---------|------------------------------------------|
| Live    | `https://www.yoursite.com`               |
| Staging | `https://feature-x.d1abc23.amplifyapp.com` |
| Path    | `/products/some-product` (optional)      |

You can also paste a full page URL into **Live**. Its path is used for both sides.

## How it works

Browsers block one page from reading or scrolling an iframe on another domain, and production sites usually refuse to be framed (`X-Frame-Options`, CSP `frame-ancestors`). To get around both, the server runs three listeners:

| Port | Purpose |
|------|---------|
| 4000 | The comparison UI |
| 4001 | Proxy for the **live** site |
| 4002 | Proxy for the **staging** site |

Each proxy serves its site **at the same paths** (for example `localhost:4001/products/x` maps to `www.yoursite.com/products/x`), so Nuxt's router and hydration see the real route. On the way through, the proxy:

- removes `X-Frame-Options`, CSP and other framing or isolation headers
- rewrites absolute links to the site's own origin, including in `window.__NUXT__` payloads, so they point back at the proxy
- keeps cookies on the proxy host by dropping `Domain`, and keeps redirects inside the proxy
- injects `/__sbs/agent.js`, a small script that reports scroll and navigation to the UI with `postMessage` and applies commands from the other pane

## Configuration (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | UI port |
| `LIVE_PORT` / `STAGING_PORT` | `4001` / `4002` | Proxy ports |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to expose on a network. |
| `ALLOWED_HOSTS` | *(any)* | Comma-separated hosts the proxy may fetch, e.g. `www.yoursite.com,*.amplifyapp.com` |
| `LIVE_PROXY_ORIGIN` / `STAGING_PROXY_ORIGIN` | *(derived)* | Public origins of the proxies when hosted, e.g. `https://live.sbs.yourco.com` |

### Hosting it for the team

The proxy will fetch any URL it's given, so if you expose it beyond localhost, **always set `ALLOWED_HOSTS`** and put it behind your SSO or VPN. A typical deployment uses three subdomains on one domain, all pointing at the same container:

```
sbs.yourco.com          -> :4000
live.sbs.yourco.com     -> :4001   LIVE_PROXY_ORIGIN=https://live.sbs.yourco.com
staging.sbs.yourco.com  -> :4002   STAGING_PROXY_ORIGIN=https://staging.sbs.yourco.com
```

Keep the subdomains under the same parent domain so the proxy's target cookie counts as same-site.

## Known limitations

- **API calls to other domains.** If the site calls an API on a different domain (e.g. `api.yoursite.com`) from the browser, that API sees a `localhost` origin and may reject it through CORS. Same-origin `/api/...` calls work because they go through the proxy.
- **Shared cookies on localhost.** Browsers ignore the port when storing cookies, so live and staging share one cookie jar on `localhost`. A login on one side can affect the other. Hosting on separate subdomains avoids this.
- **Third-party embeds** (maps, video, some analytics or consent widgets) may refuse to load or behave differently from a non-production origin.
- **Amplify password protection** works: the browser shows its basic-auth prompt inside the staging pane.
- **Service workers** registered by a site are scoped to the proxy port. If you switch to a different site on the same port and see stale content, clear site data for `localhost:4001` or `localhost:4002`.

## Development

```bash
npm test
```

Files:

- `server.js`: the UI server and the two proxies
- `public/index.html`, `public/app.js`, `public/styles.css`: the comparison UI
- `public/agent.js`: the script injected into each proxied page
