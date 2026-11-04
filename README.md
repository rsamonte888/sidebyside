# Side by Side

A web app for QA to compare a **production** page with a new **Amplify** build of the same page. Both sites load next to each other and stay in sync:

- **Synced scrolling.** Scroll either side and the other follows. You can sync *by pixel* (same offset) or *by percent* (same relative position, useful when page heights differ). **Align** snaps staging to live.
- **Synced navigation.** Click a link on either side and the other goes to the same path. For Nuxt this uses the app's own router, so there's no full reload.
- **Viewport presets.** Fit, 1920, 1440, 1280, 1024, 768, 390 and 360. Wide viewports are scaled down to fit the pane.
- **Layouts.** Side by side, stacked, or **overlay** with a staging-opacity slider and a **Difference** mode. In Difference mode identical pixels turn black, so changes stand out.
- **Shareable links.** *Copy link* captures both sites, the path, the viewport and the layout. Paste it into a ticket.
- **Team password.** A single shared password set with `APP_PASSWORD`.

Nothing has to change on your website.

## Deploy

It's a single Node server with no dependencies and no build step. Pick one option.

### Option A: Render (simplest, about 5 minutes)

1. In Render: **New → Blueprint**, then choose this GitHub repo. It reads `render.yaml`.
2. Enter `APP_PASSWORD` and `ALLOWED_HOSTS` when prompted (see below).
3. Optionally add a custom domain such as `sidebyside.yourco.com` under **Settings → Custom Domains**.

### Option B: AWS (App Runner or ECS) or any container host

Use the `Dockerfile`. The container listens on port `8080`. With App Runner: push the image to ECR, create a service from it, set the environment variables, and set the health check path to `/__sbs/health`. The same image runs on Google Cloud Run, Fly.io, Railway, or Kubernetes.

> **Why not Amplify Hosting?** Amplify Hosting is built for static sites and framework SSR. This app is a long-running reverse proxy that streams other websites, so it belongs on a container or web-service host.

### Environment variables

| Variable | Required when hosted | Description |
|----------|----------|-------------|
| `APP_PASSWORD` | **yes** | Shared password for the team. Without it, anyone with the URL can use the proxy. |
| `ALLOWED_HOSTS` | **yes** | Comma-separated hosts the proxy may load. Supports wildcards: `www.yoursite.com,yoursite.com,*.amplifyapp.com` |
| `PORT` | set by host | Port to listen on (default `4000` locally) |
| `PUBLIC_URL` | no | Public base URL, e.g. `https://sidebyside.yourco.com`. Only needed if your host doesn't send `X-Forwarded-Host`. |

## Using it

Open the app, sign in, and enter:

| Field   | Example                                    |
|---------|--------------------------------------------|
| Live    | `https://www.yoursite.com`                 |
| Staging | `https://feature-x.d1abc23.amplifyapp.com` |
| Path    | `/products/some-product` (optional)        |

You can also paste a full page URL into **Live**. Its path is used for both sides.

## How it works

Browsers block one page from reading or scrolling an iframe on another domain, and production sites usually refuse to be framed (`X-Frame-Options`, CSP `frame-ancestors`). So the app serves both sites from its own origin, each under its own path:

```
https://sidebyside.yourco.com/x/www.yoursite.com/products/x
https://sidebyside.yourco.com/x/feature-x.d1abc23.amplifyapp.com/products/x
```

On the way through, the proxy:

- removes `X-Frame-Options`, CSP and other framing or isolation headers
- adds the `/x/<site>` prefix to root-relative URLs (`src="/…"`, `href="/…"`, `srcset`, `url(/…)`, the Nuxt import map) and rewrites absolute links to the site
- sets Nuxt's runtime `app.baseURL` to the prefix, so Nuxt's router, `useFetch`/`$fetch`, payloads and lazy chunks all stay inside it, and hydration sees the right route
- routes any request that still escapes the prefix (e.g. a hand-written `fetch('/api/…')`) to the correct site by its `Referer`
- scopes each site's cookies to its own prefix, so live and staging sessions don't collide
- injects `/__sbs/agent.js`, which reports scroll and navigation to the UI with `postMessage` and applies commands from the other pane

## Known limitations

- **APIs on other domains.** If the site calls an API on a different domain (e.g. `api.yoursite.com`) from the browser, that API sees the Side by Side origin and may reject it through CORS. Same-origin `/api/...` calls work.
- **Third-party embeds** (maps, video, some analytics, consent or chat widgets) may refuse to load or behave differently from a non-production domain.
- **Absolute URLs built in JavaScript** at runtime from hard-coded strings other than the site's own origin are not rewritten.
- **Amplify password-protected branches** work: the browser shows its basic-auth prompt inside the staging pane.
- **Nuxt 2** works for display and scroll sync, but its router base is compiled into the bundle, so client-side navigation sync falls back to full page loads.

## Run locally

Requires Node 18.17 or newer.

```bash
npm start
```

Then open http://localhost:4000.

```bash
npm test
```

Files:

- `server.js`: the HTTP server, proxy, rewriting and login
- `public/index.html`, `public/app.js`, `public/styles.css`: the comparison UI
- `public/agent.js`: the script injected into each proxied page
- `Dockerfile`, `render.yaml`: deployment
