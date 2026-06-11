# Implementation

## Stack

- FastAPI for HTTP API and UI routing
- Jinja2 for HTML templates
- SQLite for persistence
- vanilla JS for dashboard interactivity

## Data model

### bins

- `id`: public bin id
- `name`: display name
- `created_at`, `updated_at`

### webhook_messages

- `bin_id`: parent bin
- `received_at`: storage timestamp
- `method`, `path`, `query_string`
- `remote_addr`, `content_type`
- `headers_json`: full request headers
- `body_text`: decoded body for display
- `body_base64`: exact raw body
- `signature_status`, `signature_details`: HMAC verification result (when enabled)

## Request flow

1. Client creates bin through `/api/bins`.
2. App returns ingest URL `/hooks/{bin_id}`.
3. POST request hits ingest route.
4. App stores headers and body in SQLite.
5. UI dashboard polls message list and loads selected message detail.
6. JSON bodies are parsed for easier reading, which works well for structured webhook payloads.

## UI flow

- Home page lists bins.
- Bin page shows ingest URL and message feed.
- Clicking message loads full headers and body.
- Dashboard auto-refreshes every 5 seconds.

## Local storage

- `data/webhook_bin.db`
- WAL mode enabled for safer local concurrent reads/writes

## Deployment notes

- app binds `0.0.0.0:8000`
- `PUBLIC_BASE_URL` can override generated links for public access
- `WEBHOOK_BIN_FORWARDED_ALLOW_IPS` lets Uvicorn trust reverse-proxy headers
- behind reverse proxy for public access
- static assets ship with package
- no external services required

## Static assets

- Frontend is vanilla JS + CSS shipped with the package under `static/`.
- A short content hash is computed at startup and appended to asset URLs
  (`app.js?v=<hash>`) so browsers always load the current version after a
  deploy/restart.

## Public tunnel choice

See `public-access.md`. Short version: Cloudflare Tunnel is best default for public use; ngrok is best for quick demos.
