# Configuration

All settings are environment variables. Every variable is optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBHOOK_BIN_HOST` | `0.0.0.0` | Bind host. |
| `WEBHOOK_BIN_PORT` | `8000` | Bind port. |
| `WEBHOOK_BIN_RELOAD` | `false` | Set `true` for dev auto-reload. |
| `PUBLIC_BASE_URL` | _(request host)_ | Public URL shown in dashboard + API responses. Set this when behind a tunnel/proxy. |
| `WEBHOOK_BIN_FORWARDED_ALLOW_IPS` | `127.0.0.1,::1` | Trusted proxy IPs for `X-Forwarded-*` headers. |
| `WEBHOOK_BIN_MAX_BODY_BYTES` | `1048576` (1 MB) | Max accepted webhook payload size. |
| `WEBHOOK_BIN_HMAC_SECRET` | _(unset)_ | Shared secret for HMAC SHA256 signature verification. When unset, signatures are reported as `disabled`. |
| `WEBHOOK_BIN_RETENTION_DAYS` | `0` | Delete messages older than N days. `0` disables. |
| `WEBHOOK_BIN_RETENTION_MAX_MESSAGES` | `0` | Keep only the latest N messages per bin. `0` disables. |

## Notes

- **`PUBLIC_BASE_URL`** keeps ingest URLs and API links correct when the app
  sits behind a tunnel or reverse proxy. Set it to whatever public URL the
  tunnel gives you.
- **HMAC** — when `WEBHOOK_BIN_HMAC_SECRET` is set, incoming requests are
  verified and each message shows a `verified` / `failed` / `missing` status.
- **Retention** runs per bin; combine days + max-messages to cap disk usage on
  long-running deployments.

## UI-only toggles

- Append `?debug=1` to a bin dashboard URL to reveal the "Seed sample" button.
  This is a client-side flag, not an environment variable.
