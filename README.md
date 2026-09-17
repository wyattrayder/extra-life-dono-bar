# extra-life-dono-bar

This is a donation bar tracker for my Extra Life streams.

## Architecture

This project is split into two parts:

- Frontend: static HTML/CSS/JS hosted on GitHub Pages
- Backend proxy: Cloudflare Worker that forwards requests to the Extra Life API

The browser cannot call the Extra Life API directly from a GitHub Pages site because Extra Life does not send the required CORS headers. The Worker acts as a server-side proxy, so the browser only talks to Cloudflare and Cloudflare talks to Extra Life.

## Frontend deployment on GitHub Pages

The site is deployed as a static site from the GitHub repo.

Typical setup:

1. Push changes to the main branch of the GitHub Pages repo.
2. In the repository settings, enable GitHub Pages.
3. Choose the branch and root folder for the static site.
4. GitHub Pages will publish the site automatically.
5. Each commit to the default branch can trigger a fresh deployment.

This gives you a free, automatic frontend deployment flow with no custom server needed.

## Cloudflare Worker setup

The proxy lives in the separate `cloudflare-worker` folder.

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Log in

```bash
cd cloudflare-worker
npx wrangler login
```

### 3. Register a workers.dev subdomain

When prompted, accept the free Workers.dev subdomain registration. This creates a URL like:

```text
https://extra-life-proxy.extra-life-proxy.workers.dev
```

### 4. Deploy the Worker

```bash
npx wrangler deploy
```

### 5. Update the frontend URL

The frontend uses the Worker URL in `script.js`:

```js
const PROXY_BASE_URL = "https://extra-life-proxy.extra-life-proxy.workers.dev";
```

Any fetches to the Extra Life API should go through this Cloudflare URL rather than the raw Extra Life domain.

## Worker behavior

The Worker listens on routes like:

```text
/api/participants/:id
/api/participants/:id/donations
/api/participants/:id/incentives
/api/participants/:id/incentives/:incentiveId
```

It forwards the request to:

```text
https://www.extra-life.org/api/...
```

and adds the required CORS headers so the GitHub Pages frontend can consume the response.

## Local development

For local testing, you can run the Worker locally:

```bash
cd cloudflare-worker
npx wrangler dev --local
```

Then test URLs such as:

```text
http://localhost:8787/api/participants/565898
```

## Notes

- GitHub Pages handles the public frontend.
- Cloudflare Workers handles the API proxy.
- This keeps the setup free and avoids browser CORS restrictions.
- The frontend repo and Worker repo can be separate projects, but both are connected by the Worker URL configured in the frontend.
