from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import shlex
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import db


BASE_DIR = Path(__file__).resolve().parent
TEMPLATES = Jinja2Templates(directory=str(BASE_DIR / "templates"))
MAX_BODY_BYTES = int(os.getenv("WEBHOOK_BIN_MAX_BODY_BYTES", str(1 * 1024 * 1024)))
HMAC_SECRET = os.getenv("WEBHOOK_BIN_HMAC_SECRET", "").encode("utf-8")
RETENTION_DAYS = int(os.getenv("WEBHOOK_BIN_RETENTION_DAYS", "0") or "0")
RETENTION_MAX_MESSAGES = int(os.getenv("WEBHOOK_BIN_RETENTION_MAX_MESSAGES", "0") or "0")
LOGGER = logging.getLogger("webhook_bin")
if not LOGGER.handlers:
    logging.basicConfig(level=logging.INFO)


def _static_hash() -> str:
    """Short hash of static assets for cache-busting."""
    h = hashlib.md5()
    for name in ("app.js", "styles.css"):
        p = BASE_DIR / "static" / name
        if p.exists():
            h.update(p.read_bytes())
    return h.hexdigest()[:8]


STATIC_VER = _static_hash()
TEMPLATES.env.globals["static_ver"] = STATIC_VER


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.initialize()
    yield


app = FastAPI(title="Webhook Bin", version="0.1.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#11182c"/>
  <path d="M18 20h28v8H26v4h18v12H18z" fill="#7c9cff"/>
</svg>
"""


def make_bin_id() -> str:
    return secrets.token_hex(4)


def base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


def public_base_url(request: Request) -> str:
    return os.getenv("PUBLIC_BASE_URL") or base_url(request)


def verify_signature(headers: dict[str, str], body: bytes) -> tuple[str, str]:
    if not HMAC_SECRET:
        return "disabled", "WEBHOOK_BIN_HMAC_SECRET not set"
    provided = (
        headers.get("x-signature-sha256")
        or headers.get("x-hub-signature-256")
        or headers.get("x-mist-signature-v2")
        or headers.get("x-signature")
    )
    if not provided:
        return "missing", "No supported signature header found"
    if provided.startswith("sha256="):
        provided = provided.split("=", 1)[1]
    expected = hmac.new(HMAC_SECRET, body, hashlib.sha256).hexdigest()
    if hmac.compare_digest(provided.strip().lower(), expected.lower()):
        return "verified", "HMAC SHA256 valid"
    return "failed", "HMAC SHA256 mismatch"


def message_to_curl(message: dict) -> str:
    url = f"http://example.local{message['path']}"
    if message.get("query_string"):
        url = f"{url}?{message['query_string']}"
    parts = ["curl", "-X", message["method"], shlex.quote(url)]
    for header, value in (message.get("headers") or {}).items():
        if header in {"host", "content-length"}:
            continue
        parts.extend(["-H", shlex.quote(f"{header}: {value}")])
    body = message.get("body_text")
    if body:
        parts.extend(["--data-raw", shlex.quote(body)])
    return " ".join(parts)


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    bins = db.list_bins()
    total_messages = sum(int(bin_data["message_count"] or 0) for bin_data in bins)
    latest_activity = next((bin_data["last_message_at"] for bin_data in bins if bin_data["last_message_at"]), None)
    return TEMPLATES.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "bins": bins,
            "base_url": public_base_url(request),
            "total_bins": len(bins),
            "total_messages": total_messages,
            "latest_activity": latest_activity,
        },
    )


@app.get("/favicon.svg")
def favicon_svg():
    return Response(content=FAVICON_SVG, media_type="image/svg+xml")


@app.get("/favicon.ico", include_in_schema=False)
def favicon_ico():
    return Response(status_code=204)


@app.get("/robots.txt", include_in_schema=False)
def robots_txt():
    return Response(content="User-agent: *\nDisallow:\n", media_type="text/plain")


@app.post("/api/bins")
async def create_bin(request: Request):
    raw_body = await request.body()
    if raw_body:
        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON body") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object")
    else:
        payload = {}
    name = str(payload.get("name", "")).strip() or "Default bin"
    bin_id = make_bin_id()
    created = db.create_bin(bin_id, name)
    return JSONResponse(
        {
            "bin": created,
            "dashboard_url": f"{public_base_url(request)}/bins/{bin_id}",
            "ingest_url": f"{public_base_url(request)}/hooks/{bin_id}",
        },
        status_code=201,
    )


@app.get("/api/bins")
def api_bins():
    return {"bins": db.list_bins()}


@app.get("/api/bins/{bin_id}")
def api_bin(bin_id: str):
    bin_data = db.get_bin(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="Bin not found")
    return {"bin": bin_data}


@app.delete("/api/bins/{bin_id}")
def delete_api_bin(bin_id: str):
    if not db.delete_bin(bin_id):
        raise HTTPException(status_code=404, detail="Bin not found")
    return {"status": "deleted", "bin_id": bin_id}


@app.post("/delete/{bin_id}")
def delete_bin_redirect(bin_id: str):
    if not db.delete_bin(bin_id):
        raise HTTPException(status_code=404, detail="Bin not found")
    return RedirectResponse(url="/", status_code=303)


@app.get("/bins/{bin_id}", response_class=HTMLResponse)
def bin_dashboard(request: Request, bin_id: str):
    bin_data = db.get_bin(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="Bin not found")
    return TEMPLATES.TemplateResponse(
        request=request,
        name="bin.html",
        context={
            "bin": bin_data,
            "base_url": public_base_url(request),
        },
    )


@app.get("/api/bins/{bin_id}/messages")
def api_messages(
    bin_id: str,
    limit: int = 100,
    before_id: int | None = None,
    method: str | None = None,
    q: str | None = None,
    header_key: str | None = None,
    header_value: str | None = None,
    since: str | None = None,
    until: str | None = None,
):
    bin_data = db.get_bin(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="Bin not found")
    messages, next_before_id = db.list_messages(
        bin_id,
        limit=max(1, min(limit, 500)),
        before_id=before_id,
        method=method,
        query=q,
        header_key=header_key,
        header_value=header_value,
        since=since,
        until=until,
    )
    return {
        "bin": bin_data,
        "messages": messages,
        "next_before_id": next_before_id,
    }


@app.get("/api/messages/{message_id}")
def api_message(message_id: int):
    message = db.get_message(message_id)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    return {"message": message}


@app.get("/api/messages/{message_id}/export")
def api_message_export(message_id: int):
    message = db.get_message(message_id)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    return JSONResponse(
        {"message": message},
        headers={"content-disposition": f'attachment; filename="message-{message_id}.json"'},
    )


@app.get("/api/messages/{message_id}/curl", response_class=Response)
def api_message_curl(message_id: int):
    message = db.get_message(message_id)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    return Response(message_to_curl(message), media_type="text/plain")


@app.get("/api/bins/{bin_id}/export.ndjson", response_class=Response)
def api_bin_export_ndjson(bin_id: str):
    if not db.get_bin(bin_id):
        raise HTTPException(status_code=404, detail="Bin not found")
    before_id = None
    lines: list[str] = []
    while True:
        rows, next_before_id = db.list_messages(bin_id, limit=500, before_id=before_id)
        if not rows:
            break
        for row in rows:
            lines.append(json.dumps(row, sort_keys=True))
        if not next_before_id:
            break
        before_id = next_before_id
    payload = "\n".join(lines) + ("\n" if lines else "")
    return Response(
        payload,
        media_type="application/x-ndjson",
        headers={"content-disposition": f'attachment; filename="{bin_id}.ndjson"'},
    )


@app.get("/api/bins/{bin_id}/stream")
async def stream_messages(bin_id: str, request: Request):
    if not db.get_bin(bin_id):
        raise HTTPException(status_code=404, detail="Bin not found")

    async def event_gen():
        try:
            last_event_id = int(request.headers.get("last-event-id", "0") or "0")
        except ValueError:
            last_event_id = 0
        while True:
            if await request.is_disconnected():
                break
            latest_id = db.get_latest_message_id(bin_id)
            if latest_id > last_event_id:
                last_event_id = latest_id
                payload = json.dumps({"type": "new_message", "latest_id": latest_id})
                yield f"id: {latest_id}\nevent: message\ndata: {payload}\n\n"
            else:
                yield ": keepalive\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
            "connection": "keep-alive",
        },
    )


@app.api_route("/hooks/{bin_id}", methods=["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def ingest_hook(bin_id: str, request: Request):
    bin_data = db.get_bin(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="Bin not found")

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_BODY_BYTES:
                raise HTTPException(status_code=413, detail="Payload too large")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header") from exc

    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Payload too large")
    headers = {k.lower(): v for k, v in request.headers.items()}
    signature_status, signature_details = verify_signature(headers, body)
    message = db.store_message(
        bin_id=bin_id,
        method=request.method,
        path=request.url.path,
        query_string=str(request.url.query),
        remote_addr=request.client.host if request.client else None,
        content_type=request.headers.get("content-type"),
        headers=headers,
        body=body,
        signature_status=signature_status,
        signature_details=signature_details,
    )
    db.apply_retention(
        bin_id=bin_id,
        max_messages=RETENTION_MAX_MESSAGES if RETENTION_MAX_MESSAGES > 0 else None,
        retention_days=RETENTION_DAYS if RETENTION_DAYS > 0 else None,
    )
    LOGGER.info(
        json.dumps(
            {
                "event": "webhook_ingested",
                "bin_id": bin_id,
                "message_id": message["id"],
                "method": request.method,
                "remote_addr": request.client.host if request.client else None,
                "content_type": request.headers.get("content-type"),
                "signature_status": signature_status,
                "body_size": len(body),
            }
        )
    )
    ack = {
        "id": message["id"],
        "bin_id": message["bin_id"],
        "received_at": message["received_at"],
        "signature_status": message["signature_status"],
    }
    return JSONResponse({"status": "stored", "message": ack}, status_code=201)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/metrics", response_class=Response)
def metrics():
    metric_values = db.get_metrics()
    lines = [
        "# HELP webhook_bin_bins_total Total number of bins",
        "# TYPE webhook_bin_bins_total gauge",
        f"webhook_bin_bins_total {metric_values['bins_total']}",
        "# HELP webhook_bin_messages_total Total stored webhook messages",
        "# TYPE webhook_bin_messages_total gauge",
        f"webhook_bin_messages_total {metric_values['messages_total']}",
        "# HELP webhook_bin_retention_days Configured retention days",
        "# TYPE webhook_bin_retention_days gauge",
        f"webhook_bin_retention_days {RETENTION_DAYS}",
        "# HELP webhook_bin_retention_max_messages Configured max messages per bin",
        "# TYPE webhook_bin_retention_max_messages gauge",
        f"webhook_bin_retention_max_messages {RETENTION_MAX_MESSAGES}",
    ]
    return Response("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4")


@app.post("/api/bins/{bin_id}/seed")
async def seed_bin(bin_id: str):
    bin_data = db.get_bin(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="Bin not found")
    sample = {
        "source": "webhook-bin",
        "event": "sample",
        "note": "Local test payload",
    }
    db.store_message(
        bin_id=bin_id,
        method="POST",
        path=f"/hooks/{bin_id}",
        query_string="",
        remote_addr=None,
        content_type="application/json",
        headers={"content-type": "application/json"},
        body=json.dumps(sample).encode("utf-8"),
    )
    return RedirectResponse(url=f"/bins/{bin_id}", status_code=303)


def run_backup_command(args: list[str]) -> None:
    if len(args) != 1:
        raise SystemExit("Usage: webhook-bin backup <path-to-backup-db>")
    db.initialize()
    db.backup_database(args[0])
    print(f"Backup created at {args[0]}")


def run_restore_command(args: list[str]) -> None:
    if len(args) != 1:
        raise SystemExit("Usage: webhook-bin restore <path-to-backup-db>")
    db.restore_database(args[0])
    db.initialize()
    print(f"Database restored from {args[0]}")


def main() -> None:
    import uvicorn

    if len(sys.argv) > 1:
        command = sys.argv[1].strip().lower()
        command_args = sys.argv[2:]
        if command == "backup":
            run_backup_command(command_args)
            return
        if command == "restore":
            run_restore_command(command_args)
            return
        raise SystemExit("Unknown command. Use: webhook-bin [backup|restore]")

    uvicorn.run(
        "webhook_bin.main:app",
        host=os.getenv("WEBHOOK_BIN_HOST", "0.0.0.0"),
        port=int(os.getenv("WEBHOOK_BIN_PORT", "8000")),
        reload=os.getenv("WEBHOOK_BIN_RELOAD", "false").lower() == "true",
        proxy_headers=True,
        forwarded_allow_ips=os.getenv("WEBHOOK_BIN_FORWARDED_ALLOW_IPS", "127.0.0.1,::1"),
    )


if __name__ == "__main__":  # pragma: no cover
    main()
