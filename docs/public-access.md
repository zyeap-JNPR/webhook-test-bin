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

### Cloudflare Quick Tunnel

Quick Tunnels provide a temporary public URL without a Cloudflare account or
domain. They are intended for testing, not production, and have no uptime
guarantee.

1. [Install cloudflared](https://developers.cloudflare.com/tunnel/downloads/)
   for your operating system and architecture.
2. Start webhook-bin and check that it is healthy:

   ```bash
   curl -f http://127.0.0.1:8000/healthz
   ```

3. In another terminal, start the tunnel:

   ```bash
   cloudflared tunnel --url http://127.0.0.1:8000
   ```

4. Copy the `https://...trycloudflare.com` URL printed by cloudflared. Verify it
   from another machine:

   ```bash
   curl -f https://YOUR-URL.trycloudflare.com/healthz
   ```

5. Open that URL, create a bin, and use its `/hooks/<bin_id>` URL as the
   sender's destination. If the displayed ingest URL is incorrect, configure
   `PUBLIC_BASE_URL` for the app and restart it.

Stop the foreground tunnel with Ctrl+C. A new tunnel gets a new URL, so update
the sender when it changes.

On Linux with systemd, a transient service can keep the tunnel running after
you disconnect. Use this *instead* of starting the foreground tunnel:

```bash
sudo systemd-run --unit=webhook-bin-cloudflared \
  --uid="$(id -un)" --setenv="HOME=$HOME" \
  "$(command -v cloudflared)" tunnel --no-autoupdate \
  --url http://127.0.0.1:8000
journalctl -u webhook-bin-cloudflared.service -n 50 --no-pager
```

Find the most recently generated URL in the logs. Check or stop the service
with:

```bash
systemctl is-active webhook-bin-cloudflared.service
sudo systemctl stop webhook-bin-cloudflared.service
```

The transient service does not survive a reboot. Starting a new tunnel creates
a different URL.

The URL exposes the entire app, including its dashboard, to anyone who has it.
Do not use sensitive data or credentials. Quick Tunnels do not support
Server-Sent Events; the dashboard falls back to polling. For details and other
limits, see the [Quick Tunnels documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

### ngrok

```bash
ngrok http 8000
export PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app
webhook-bin
```

## App setting

Set `PUBLIC_BASE_URL` to whatever public URL the tunnel gives you.
That keeps dashboard links and API responses correct when the app sits behind a tunnel or reverse proxy.
