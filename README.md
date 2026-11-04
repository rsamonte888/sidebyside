# Side by Side

A web app for QA to compare a **production** page with a new **Amplify** build of the same page. Both sites load next to each other and stay in sync:

- **Synced scrolling.** Scroll either side and the other follows. You can sync *by pixel* (same offset) or *by percent* (same relative position, useful when page heights differ). **Align** snaps staging to live.
- **Synced navigation.** Click a link on either side and the other goes to the same path. For Nuxt this uses the app's own router, so there's no full reload.
- **Synced clicks.** Opening an accordion, tab or toggle on one side opens the same one on the other. The match is made by its text, with a fallback to its position in the page. Links, form fields and submit buttons are never mirrored, so nothing is submitted twice.
- **Figma vs. staging.** Paste a Figma frame link (right-click the frame → *Copy link to selection*) into either box. The frame shows as an image at its real width, the viewport switches to match, and scroll sync, overlay/difference, annotations and share links all work against it. Needs `FIGMA_TOKEN`.
- **Just one site.** Leave Staging (or Live) empty to load a single site full width, e.g. to annotate production on its own. Annotations, screenshots, notes and share links all work.
- **Both or one.** Switch between **Both**, **Live only** and **Staging only** (or use the ⤢ button on a pane) to see one site full width. The hidden site keeps syncing, so switching back lines up straight away.
- **Viewport presets.** Fit, 1920, 1440, 1280, 1024, 768, 390 and 360. Wide viewports are scaled down to fit the pane.
- **Layouts.** Side by side, stacked, or **overlay** with a staging-opacity slider and a **Difference** mode. In Difference mode identical pixels turn black, so changes stand out.
- **Shareable links.** *Copy link* captures both sites, the page, the viewport and the layout. If there are annotations, the link also carries them, the summary and both scroll positions (compressed into the link, nothing stored on a server), so it opens that exact screen. Someone who isn't signed in is sent back to the link after signing in.
- **Annotate & screenshot.** Drop numbered callouts or draw boxes over the pages, add a summary, then take a screenshot (with a header naming the page, URLs, viewport and date) to copy or download for the ticket. **Copy notes as text** gives the matching ticket text.
- **Team password.** A single shared password set with `APP_PASSWORD`.

Nothing has to change on your website.

## Deploy on Netlify (free)

1. In Netlify: **Add new project → Import an existing project → GitHub**, then pick this repo and branch.
2. Leave the build settings alone. `netlify.toml` already sets them (no build command; publish directory `public`).
3. Under **Environment variables**, add `APP_PASSWORD` and `ALLOWED_HOSTS` (see below).
4. Click **Deploy**. If you add or change environment variables later, run **Deploys → Trigger deploy** so they take effect.

The UI is served as static files and everything else runs in one Netlify Function (`netlify/functions/proxy.mjs`). Every file a proxied page loads counts as a function call, and the traffic counts as bandwidth. A QA team's normal use should fit in the free plan, but check **Usage** in Netlify after the first week.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `APP_PASSWORD` | **yes** | Shared password for the team. Without it, anyone with the URL can use the proxy. |
| `ALLOWED_HOSTS` | **yes** | Comma-separated hosts the proxy may load. Supports wildcards: `www.yoursite.com,yoursite.com,*.amplifyapp.com` |
| `FIGMA_TOKEN` | for Figma | A Figma personal access token (Figma → Settings → Security → Personal access tokens, scope *File content: read-only*). It stays on the server and is used to render frames as images. |
| `PUBLIC_URL` | no | Public base URL, if you see wrong links after adding a custom domain. |

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

Requires Node 20 or newer.

```bash
npm start
```

Then open http://localhost:4000.

```bash
npm test
```

Files:

- `lib/core.js`: proxy, rewriting and login (shared by Netlify and local)
- `netlify/functions/proxy.mjs`: the Netlify Function entry point
- `server.js`: local dev server that mimics Netlify
- `public/index.html`, `public/__sbs/ui/`: the comparison UI
- `public/__sbs/agent.js`: the script injected into each proxied page
