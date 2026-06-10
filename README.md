# Webhook Bin

Local-first webhook inbox for testing webhook payloads, headers, and traffic.

## What it does

- creates bins with unique ingest URLs
- stores webhook requests in SQLite
- shows a landing page with bin summary data
- shows message list, headers, and body in UI dashboard
- supports live message updates (SSE) with polling fallback
- supports message search/filter + cursor pagination
- supports message and bin export (JSON, cURL, NDJSON)
- includes UTC/PT timestamp toggle in UI header
- supports typed-confirm delete flow in UI
- supports optional HMAC signature verification
- supports optional retention policy (days / max messages per bin)
- exposes JSON APIs for bins and messages
- works locally now, easy to move onto Raspberry Pi later

## Run local

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
webhook-bin
```

Open:
- UI: `http://127.0.0.1:8000/`
- API docs: `http://127.0.0.1:8000/docs`

## Run tests

```bash
source .venv/bin/activate
pip install -e '.[test]'
pytest --cov=webhook_bin --cov-report=term-missing
```

## Public exposure

Best option for always-on public access: **Cloudflare Tunnel**.

Use **ngrok** for fast temporary sharing. Use **Tailscale Funnel** only if you already use Tailscale and accept beta limits.

Run on `0.0.0.0` and put reverse proxy or tunnel in front.

Optional env vars:

- `PUBLIC_BASE_URL` — public URL shown in dashboard and API responses
- `WEBHOOK_BIN_HOST` — bind host, default `0.0.0.0`
- `WEBHOOK_BIN_PORT` — bind port, default `8000`
- `WEBHOOK_BIN_RELOAD` — `true` for dev reload
- `WEBHOOK_BIN_FORWARDED_ALLOW_IPS` — trusted proxy IPs for forwarded headers, default `127.0.0.1,::1`
- `WEBHOOK_BIN_MAX_BODY_BYTES` — max webhook payload size, default `1048576` (1 MB)
- `WEBHOOK_BIN_HMAC_SECRET` — shared secret for HMAC SHA256 verification
- `WEBHOOK_BIN_RETENTION_DAYS` — delete messages older than N days (0 disables)
- `WEBHOOK_BIN_RETENTION_MAX_MESSAGES` — keep latest N messages per bin (0 disables)

See `docs/public-access.md` for recommended tunnel setups and commands.

## Usage

1. Open dashboard.
2. Create bin.
3. Copy ingest URL.
4. POST webhook payload.
5. Read headers/body in bin dashboard.

### Send test webhook

```bash
curl -X POST http://127.0.0.1:8000/hooks/<bin_id> \
  -H 'content-type: application/json' \
  -H 'x-demo: true' \
  -d '{"hello":"world"}'
```

Any webhook sender works same way: POST JSON to `/hooks/<bin_id>`, inspect headers, then read parsed JSON in dashboard.

### List bins

```bash
curl http://127.0.0.1:8000/api/bins
```

### View messages

```bash
curl http://127.0.0.1:8000/api/bins/<bin_id>/messages?limit=100
curl http://127.0.0.1:8000/api/messages/<message_id>
```

Filter + cursor examples:

```bash
curl "http://127.0.0.1:8000/api/bins/<bin_id>/messages?method=POST&q=webhook&limit=50"
curl "http://127.0.0.1:8000/api/bins/<bin_id>/messages?before_id=<next_before_id>&limit=50"
```

### Delete bin

```bash
curl -X DELETE http://127.0.0.1:8000/api/bins/<bin_id>
# or browser/form route
curl -X POST http://127.0.0.1:8000/delete/<bin_id>
```

### Export

```bash
curl http://127.0.0.1:8000/api/messages/<message_id>/export
curl http://127.0.0.1:8000/api/messages/<message_id>/curl
curl http://127.0.0.1:8000/api/bins/<bin_id>/export.ndjson
```

### Metrics

```bash
curl http://127.0.0.1:8000/metrics
```

### Backup / restore database

```bash
webhook-bin backup ./backups/webhook_bin.db
webhook-bin restore ./backups/webhook_bin.db
```

## API

| Method | Path | Use |
| --- | --- | --- |
| GET | `/` | UI home |
| POST | `/api/bins` | Create bin |
| GET | `/api/bins` | List bins |
| GET | `/api/bins/{bin_id}` | Bin detail |
| DELETE | `/api/bins/{bin_id}` | Delete bin + messages |
| POST | `/delete/{bin_id}` | Delete bin + redirect home |
| GET | `/bins/{bin_id}` | Bin dashboard |
| POST/PUT/PATCH/DELETE/OPTIONS | `/hooks/{bin_id}` | Store webhook |
| GET | `/api/bins/{bin_id}/messages` | List messages |
| GET | `/api/bins/{bin_id}/stream` | SSE live update stream |
| GET | `/api/messages/{message_id}` | Message detail |
| GET | `/api/messages/{message_id}/export` | Download message JSON |
| GET | `/api/messages/{message_id}/curl` | Get replay cURL command |
| GET | `/api/bins/{bin_id}/export.ndjson` | Export bin as NDJSON |
| GET | `/metrics` | Prometheus metrics |

## Raspberry Pi deploy

1. Install Python 3.11+.
2. Clone or copy app.
3. Create venv and install package.
4. Run behind `systemd` or `supervisor`.
5. Put nginx or Caddy in front if you want TLS.

Example `systemd` unit:

```ini
[Unit]
Description=Webhook Bin
After=network.target

[Service]
WorkingDirectory=/opt/webhook-bin
ExecStart=/opt/webhook-bin/.venv/bin/webhook-bin
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

## Data

SQLite file lives at `data/webhook_bin.db`.
Delete file to reset app.
