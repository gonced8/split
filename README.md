# Split

Receipt splitting web app (React + TypeScript + Vite + Tailwind + shadcn-style UI primitives).

## Features

- Upload or capture receipt photo
- Interactive corner dragging to crop the receipt area
- Perspective flattening (homography warp)
- **AI-powered extraction** via Google Gemini API through a Cloudflare Worker proxy
- Editable receipt items (name, quantity, price) with currency auto-detection
- People list with rename + add person
- Allocation table with float quantities per person per item
- Tip (percent or fixed amount)
- Final split totals per person

## Stack

- React + TypeScript + Vite
- TailwindCSS
- shadcn-style local UI components (`src/components/ui/*`)
- Cloudflare Worker proxy → Google Gemini API (`gemini-3.1-flash-lite-preview`)

## Run locally

```bash
npm install
cp .env.example .env          # then edit (see below)
npm run dev
```

**Option A – Proxy (production-like):** Set `VITE_PROXY_URL` to your Worker URL. The Worker must allow your dev origin (e.g. `http://localhost:5173`) in `ALLOWED_ORIGIN`, which opens the endpoint to anyone using that origin.

**Option B – Direct API key (recommended for dev):** Set `VITE_GEMINI_API_KEY` in `.env` (get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)). The app will call Gemini directly and skip the Worker, so you don’t add localhost to the Worker. In Google Cloud, restrict that key to **HTTP referrers** `http://localhost:*` (and optionally your production domain).

## Build

```bash
npm run build
npm run preview
```

## Cloudflare Worker setup

The app sends receipt images to a Cloudflare Worker, which holds your Gemini API key and proxies requests. This keeps the key off the client.

The worker is TypeScript ([`worker/index.ts`](worker/index.ts)). The dashboard “Quick edit” uploader does **not** support TypeScript, so you must deploy with the CLI.

### 1. Deploy the worker

From this repo (after `npm install`):

```bash
# Set secrets first (one-time)
npx wrangler secret put GEMINI_API_KEY    # paste key from https://aistudio.google.com/apikey
npx wrangler secret put ALLOWED_ORIGIN    # e.g. https://split.goncaloraposo.com

# Deploy
npm run deploy:worker
```

The worker URL will be printed (e.g. `https://split-proxy.<your-subdomain>.workers.dev`).

### 2. Configure the frontend

**For local dev**, create `.env` with either:
- `VITE_PROXY_URL=https://split-proxy.your-subdomain.workers.dev` (and allow localhost in the Worker), or
- `VITE_GEMINI_API_KEY=your_key` (direct call; restrict the key to localhost in Google Cloud).

**For GitHub Pages**, go to your repo:

1. **Settings** → **Environments** → **github-pages** (or create it)
2. Add a **variable** (not secret): `VITE_PROXY_URL` = `https://split-proxy.your-subdomain.workers.dev`

The deploy workflow already reads this variable at build time.

## CI

- Pull request workflow (`.github/workflows/ci.yml`) runs:
  - `npm ci`
  - `npm run lint`
  - `npm run build`

## Deploy (GitHub Pages)

A workflow is included at `.github/workflows/deploy-pages.yml`.

### One-time repo settings

1. GitHub → **Settings** → **Pages**
2. Source: **GitHub Actions**
3. (Optional) set custom domain to `split.goncaloraposo.com`

## Notes / next improvements

- Add manual rotate + auto edge detection
- Persist sessions in localStorage
- Add shared link / export summary
- Offline fallback with local OCR (Tesseract.js) when proxy is unreachable
