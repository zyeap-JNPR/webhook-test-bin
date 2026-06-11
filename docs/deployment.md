# Deployment

Run the app on a host (e.g. Raspberry Pi) and expose it publicly through a
tunnel. See `public-access.md` for tunnel choices.

## Raspberry Pi

1. Install Python 3.11+.
2. Clone the repo.
3. Create a venv and install the package:

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -e .
   ```

4. Run under `systemd` so it survives reboots (below).
5. Front it with a tunnel (Cloudflare / ngrok) for TLS + public access.

## systemd service

`/etc/systemd/system/webhook-bin.service`:

```ini
[Unit]
Description=Webhook Bin
After=network.target

[Service]
WorkingDirectory=/home/pi/webhook-test-bin
ExecStart=/home/pi/webhook-test-bin/.venv/bin/webhook-bin
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webhook-bin
```

If you run a tunnel as a service too (e.g. ngrok), give it its own unit so it
also starts on boot.

## Health & logs

```bash
systemctl status webhook-bin           # service state
journalctl -u webhook-bin -f           # live logs
journalctl -u webhook-bin --since today
curl -s http://localhost:8000/metrics  # Prometheus metrics
```

Logs go to stdout, which `systemd` captures in the journal — there is no
separate log file. Cap journal size in `/etc/systemd/journald.conf`
(`SystemMaxUse=`) and use the retention env vars to bound the SQLite database.

## Auto-update on git push

`deploy.sh` (in the repo root) polls `origin/main` and redeploys only when the
remote SHA changes. It pulls, reinstalls the package, and restarts the service.

Add it to cron to poll every 5 minutes:

```cron
*/5 * * * * /home/pi/webhook-test-bin/deploy.sh >> /home/pi/deploy.log 2>&1
```

Notes:

- The script sets a minimal `PATH` because cron runs with a stripped
  environment.
- `sudo systemctl restart` requires the service user to have passwordless sudo
  for that command (or run the cron job as root).
- A static asset version hash (computed at startup) busts browser caches, so
  UI changes appear immediately after the service restarts.

## Migrating data between hosts

The database is a single SQLite file at `data/webhook_bin.db`. To move existing
bins + messages to another host, stop the app first (to avoid write conflicts),
then copy the file:

```bash
sudo systemctl stop webhook-bin
scp data/webhook_bin.db user@target:/path/to/webhook-test-bin/data/
sudo systemctl start webhook-bin   # on target
```
