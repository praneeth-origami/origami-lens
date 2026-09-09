# Origami Lens

**Find what's wrong with any webpage.**

Origami Lens is an AI-powered webpage inspection platform that converts browser evidence into actionable insights: **Problem → Cause → Impact → Suggested Fix**.

## Architecture

```
Chrome Extension
       ↓
  Origami API
       ↓
 Browser Worker (Playwright + Chromium + CDP)
       ↓
 Lighthouse + axe-core + Origami Rule Engine
       ↓
 Issue Normalizer → Health Score Engine
       ↓
 Privacy Scrubber → AI Gateway (Qwen3.5 / Qwen3-VL / Qwen3-Coder)
       ↓
 Lens Report → Extension UI
```

**Key principle:** Deterministic evidence first. AI explains findings — it does not invent them or calculate the health score.

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **Python** >= 3.11 (for OCR service, optional)
- **Chromium** (installed via Playwright)

## Health Score Formula

Seven weighted categories (deterministic, not AI-generated):

| Category         | Weight |
|------------------|--------|
| Functional       | 25%    |
| Performance      | 20%    |
| Visual/Mobile    | 20%    |
| Accessibility    | 15%    |
| Best Practices   | 10%    |
| SEO              | 5%     |
| Security Hygiene | 5%     |

Each category starts at 100. Deductions: CRITICAL −10, HIGH −7, MEDIUM −4, LOW −2.

```
overallScore = Σ (categoryScore × weight / 100)
```

## AI Gateway

Application code requests **tasks**, not model names:

| Task              | Model                |
|-------------------|----------------------|
| summarize_scan    | Qwen3.5-4B           |
| explain_issue     | Qwen3.5-4B           |
| visual_qa         | Qwen3-VL-8B-Instruct |
| fix_code          | Qwen3-Coder-Next     |
| ocr               | PaddleOCR-VL-1.6     |
| repository_search | BGE-M3 + reranker    |

Models are served via **vLLM** (OpenAI-compatible `/v1/chat/completions`). When vLLM is unavailable, deterministic fallbacks are used — scans continue without crashing.

## Installation

```bash
pnpm install
pnpm build
npx playwright install chromium
```

Copy environment variables (optional — `pnpm dev` auto-creates `.env` from `.env.example`):

```bash
cp .env.example .env
```

For **website scans**, start infrastructure and migrate:

```bash
pnpm db:setup
```

Or step by step: `docker compose up -d` then `pnpm db:migrate`. With `.env` present, `pnpm dev` loads it automatically — no manual `$env:DATABASE_URL` needed.

| Type | Description | Storage |
|------|-------------|---------|
| **CURRENT_PAGE** | Sync scan of one URL (extension or API) | PostgreSQL + legacy JSON |
| **WEBSITE** | Async multi-page scan via Redis queue | PostgreSQL required |
| **PROJECT** | Repository scan (schema only, not implemented) | — |

### Website scans (PostgreSQL + Redis)

```bash
docker compose up -d
pnpm db:migrate
```

Ensure `.env` includes:

```
DATABASE_URL=postgresql://origami:origami@localhost:5433/origami_lens
REDIS_URL=redis://localhost:6379
```

Start website scan from the extension (**Entire Website**) or API:

```bash
curl -X POST http://localhost:3100/scans \
  -H "Content-Type: application/json" \
  -d '{"url":"http://localhost:8080","scanType":"WEBSITE","websiteOptions":{"discoveryMethod":"AUTOMATIC","maxPages":5}}'
```

Poll progress: `GET /scans/:scanId/status` · Pages: `GET /scans/:scanId/pages`

## Running Services

Start all services with one command (API **3100**, Browser Worker **3101**, AI Router **3102**, Dashboard **5173**):

```bash
pnpm dev
```

Optional test website on port **8080**:

```bash
pnpm dev:all
```

Check dependency health: `http://localhost:3100/health/dependencies`

Or start each service in a separate terminal:

```bash
# 1. Browser Worker (Playwright + Lighthouse + axe-core)
pnpm dev:browser-worker

# 2. AI Router (Origami AI Gateway)
pnpm dev:ai-router

# 3. Origami API
pnpm dev:api

# 4. Issues Dashboard
pnpm dev:web

# 5. Test website (optional)
pnpm test:website
```

**Port conflicts:** If 3100–3102 or 5173 are in use, set `API_PORT`, `BROWSER_WORKER_PORT`, `AI_ROUTER_PORT`, or change Vite port in `apps/web/vite.config.ts`.

### vLLM (optional, for GPU AI)

```bash
# Example — adjust model paths for your environment
vllm serve Qwen/Qwen3.5-4B --port 8000
```

Set in `.env`:
```
VLLM_BASE_URL=http://localhost:8000/v1
AI_ENABLED=true
```

### OCR Service (optional, Python)

```bash
cd services/ocr
pip install -r requirements.txt
python main.py
```

## Chrome Extension

Build:

```bash
pnpm build:extension
```

Load in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `apps/extension/dist`

## Testing

```bash
pnpm test
```

Test website at `http://localhost:8080` contains intentional issues:
missing title, missing alt, empty button, console error, horizontal overflow, etc.

## Project Structure

```
apps/
  api/              — Origami API (Fastify)
  extension/        — Chrome Extension (MV3)
  test-website/     — Local test fixture
services/
  browser-worker/   — Playwright + CDP + Lighthouse + axe-core
  ai-router/        — Origami AI Gateway
  ocr/              — PaddleOCR interface (Python)
  repo-worker/      — Future repository indexing
  verification/     — Future fix verification
packages/
  contracts/        — Shared types
  discovery/        — URL normalize, sitemap, crawl discovery
  rules/            — Origami Rule Engine + Issue Normalizer + website aggregator
  scoring/          — Health Score Engine + website score rollup
  privacy/          — Privacy Scrubber
```

## Issues Dashboard

Web dashboard for viewing and managing scan issues:

```bash
pnpm dev        # includes dashboard at http://localhost:5173
# or
pnpm dev:web
```

After a scan, click **Open Issues Dashboard** in the extension, or visit `/scans/{scanId}`.

For production preview (`pnpm build:web`), set `VITE_API_URL=http://localhost:3100` — see `apps/web/.env.example`. Dev mode uses the Vite proxy (`/api` → API).

### Dashboard API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/scans` | List scan history |
| GET | `/scans/:scanId` | Get scan with health score |
| GET | `/scans/:scanId/issues` | Filter/search issues |
| GET | `/scans/:scanId/artifacts/:key` | Screenshot JPEG |
| GET | `/issues/:issueId` | Issue detail |
| PATCH | `/issues/:issueId/status` | Update issue status |
| GET | `/scans/:scanId/status` | Poll website scan progress |
| GET | `/scans/:scanId/pages` | List page scans (website) |
| GET | `/scans/:scanId/pages/:pageScanId` | Page-level issues |
| POST | `/scans` | Create scan (CURRENT_PAGE sync, WEBSITE async) |
| POST | `/scan` | Run current-page scan (backward compat) |
| POST | `/ai/explain-issue` | AI issue explanation |
| POST | `/ai/ask` | Ask follow-up |
| POST | `/ai/suggest-fix` | Code fix suggestion |
| GET | `/health` | Health check |
| GET | `/health/dependencies` | API + worker + AI router status |

## Demo Flow

1. Run `docker compose up -d && pnpm db:migrate` for website scans (optional)
2. Run `pnpm dev` (or start API + Browser Worker + AI Router + Dashboard)
3. Open test website (`http://localhost:8080`) — use `pnpm dev:all` to start it automatically
4. Build/load extension (`pnpm build:extension`) → choose **Current Page** or **Entire Website**
5. View Health Score, pages table (website), and category breakdown on dashboard
6. Select an issue → Problem / Cause / Impact / Suggested Fix (+ affected pages for website scans)
7. Ask AI: "Why is this happening?"

## Known Limitations

- vLLM/GPU models require separate infrastructure; deterministic fallbacks used when unavailable
- Lighthouse runs a separate Chromium instance (may be slow on first scan)
- Repository indexing and fix verification are interface-only (future scope)
- Extension `host_permissions` limited to localhost API; extend for production deployment
- OCR service returns stub until PaddleOCR-VL is deployed
