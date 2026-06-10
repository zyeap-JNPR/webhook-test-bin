# Public access

## Recommendation

Use **Cloudflare Tunnel** for the default public deployment.

Why:
- outbound-only, so no inbound port forwarding
- good fit for Raspberry Pi
- stable enough for always-on webhook endpoints
- keeps origin private behind Cloudflare

## When to use ngrok

Use **ngrok** for quick local demos or short-lived testing.

Good when you want:
- public URL in seconds
- minimal setup
- temporary sharing

## When to use Tailscale Funnel

Use **Tailscale Funnel** only if you already run Tailscale and accept beta limits.

Tradeoffs:
- beta feature
- TLS only
- port limits
- Tailscale dependency

## Example setups

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:8000
export PUBLIC_BASE_URL=https://your-public-hostname.example.com
webhook-bin
```

### ngrok

```bash
ngrok http 8000
export PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app
webhook-bin
```

## App setting

Set `PUBLIC_BASE_URL` to whatever public URL the tunnel gives you.
That keeps dashboard links and API responses correct when the app sits behind a tunnel or reverse proxy.
