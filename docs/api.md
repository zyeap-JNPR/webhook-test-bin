# API reference

Base URL is your local or public host. Examples below use
`http://127.0.0.1:8000`.

## Endpoints

| Method | Path | Use |
| --- | --- | --- |
| GET | `/` | UI home |
| GET | `/bins/{bin_id}` | Bin dashboard |
| POST | `/api/bins` | Create bin |
| GET | `/api/bins` | List bins |
| GET | `/api/bins/{bin_id}` | Bin detail |
| DELETE | `/api/bins/{bin_id}` | Delete bin + messages |
| POST | `/delete/{bin_id}` | Delete bin + redirect home |
| POST/PUT/PATCH/DELETE/OPTIONS | `/hooks/{bin_id}` | Store webhook |
| GET | `/api/bins/{bin_id}/messages` | List messages |
| GET | `/api/bins/{bin_id}/stream` | SSE live update stream |
| GET | `/api/messages/{message_id}` | Message detail |
| GET | `/api/messages/{message_id}/export` | Download message JSON |
| GET | `/api/messages/{message_id}/curl` | Replay cURL command |
| GET | `/api/bins/{bin_id}/export.ndjson` | Export bin as NDJSON |
| GET | `/metrics` | Prometheus metrics |

Interactive OpenAPI docs are served at `/docs`.

## Send a test webhook

```bash
curl -X POST http://127.0.0.1:8000/hooks/<bin_id> \
  -H 'content-type: application/json' \
  -H 'x-demo: true' \
  -d '{"hello":"world"}'
```

Any webhook sender works the same way: POST to `/hooks/<bin_id>`, then inspect
headers and parsed JSON in the dashboard.

## List bins

```bash
curl http://127.0.0.1:8000/api/bins
```

## View messages

```bash
curl http://127.0.0.1:8000/api/bins/<bin_id>/messages?limit=100
curl http://127.0.0.1:8000/api/messages/<message_id>
```

Filter and cursor-paginate:

```bash
curl "http://127.0.0.1:8000/api/bins/<bin_id>/messages?method=POST&q=webhook&limit=50"
curl "http://127.0.0.1:8000/api/bins/<bin_id>/messages?before_id=<next_before_id>&limit=50"
```

The messages response includes `next_before_id`; pass it back as `before_id`
to fetch the next page.

## Delete a bin

```bash
curl -X DELETE http://127.0.0.1:8000/api/bins/<bin_id>
# or the browser/form route
curl -X POST http://127.0.0.1:8000/delete/<bin_id>
```

## Export

```bash
curl http://127.0.0.1:8000/api/messages/<message_id>/export
curl http://127.0.0.1:8000/api/messages/<message_id>/curl
curl http://127.0.0.1:8000/api/bins/<bin_id>/export.ndjson
```

## Metrics

```bash
curl http://127.0.0.1:8000/metrics
```

## Backup / restore database

```bash
webhook-bin backup ./backups/webhook_bin.db
webhook-bin restore ./backups/webhook_bin.db
```
