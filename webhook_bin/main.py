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
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware

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
_STREAM_SUBSCRIBERS: dict[str, set[asyncio.Queue[dict[str, object]]]] = {}


class CacheControlledStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: dict):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["cache-control"] = "public, max-age=31536000, immutable"
        return response


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
app.mount("/static", CacheControlledStaticFiles(directory=str(BASE_DIR / "static")), name="static")

# Paths to skip visitor logging (noise: health checks, assets, API polling, ingest)
_VISITOR_LOG_SKIP_PREFIXES = ("/static/", "/healthz", "/metrics", "/favicon", "/api/", "/hooks/")


class VisitorLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.monotonic()
        response = await call_next(request)
        duration_ms = int((time.monotonic() - start) * 1000)
        path = request.url.path
        if not any(path.startswith(p) for p in _VISITOR_LOG_SKIP_PREFIXES):
            ip = (
                request.headers.get("x-forwarded-for", "").split(",")[0].strip()
                or (request.client.host if request.client else None)
            )
            ua = request.headers.get("user-agent")
            referer = request.headers.get("referer")
            LOGGER.info(
                json.dumps({
                    "event": "page_visit",
                    "ip": ip,
                    "user_agent": ua,
                    "path": path,
                    "referer": referer,
                    "status_code": response.status_code,
                    "duration_ms": duration_ms,
                })
            )
            try:
                db.log_visitor(
                    ip=ip,
                    user_agent=ua,
                    path=path,
                    referer=referer,
                    status_code=response.status_code,
                    duration_ms=duration_ms,
                )
            except Exception:
                pass
        return response


# Paths where FastAPI's built-in docs UI pulls JS/CSS from an external CDN;
# a strict same-origin CSP would break them, so they're excluded here.
_CSP_EXEMPT_PATHS = ("/docs", "/redoc", "/openapi.json")

_CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'"
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("x-content-type-options", "nosniff")
        response.headers.setdefault("x-frame-options", "DENY")
        response.headers.setdefault("referrer-policy", "no-referrer")
        response.headers.setdefault("permissions-policy", "geolocation=(), camera=(), microphone=()")
        if not request.url.path.startswith(_CSP_EXEMPT_PATHS):
            response.headers.setdefault("content-security-policy", _CONTENT_SECURITY_POLICY)
        return response


app.add_middleware(VisitorLogMiddleware)
# Adds security headers to every response.
app.add_middleware(SecurityHeadersMiddleware)
# Compress responses (JSON/HTML/CSS/JS) to cut ngrok data-transfer-out volume.
# Added last (outermost) so it wraps and compresses the final response body
# (SSE streams are naturally excluded: too small/streamed).
app.add_middleware(GZipMiddleware, minimum_size=500)

FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#1e1e2e"/>
  <path d="M18 20h28v8H26v4h18v12H18z" fill="#a6e3a1"/>
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


def message_to_stream_summary(message: dict) -> dict[str, object]:
    content_type = str(message.get("content_type") or "").lower()
    return {
        "id": message["id"],
        "bin_id": message["bin_id"],
        "received_at": message["received_at"],
        "method": message["method"],
        "path": message["path"],
        "query_string": message.get("query_string", ""),
        "body_preview": message.get("body_preview", ""),
        "has_json": bool(message.get("body_json") is not None or "json" in content_type),
        "signature_status": message.get("signature_status"),
    }


def publish_stream_message(bin_id: str, message: dict) -> None:
    subscribers = _STREAM_SUBSCRIBERS.get(bin_id)
    if not subscribers:
        return
    event = {
        "type": "new_message",
        "latest_id": int(message["id"]),
        "message": message_to_stream_summary(message),
    }
    for queue in tuple(subscribers):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass


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
    return Response(
        content=FAVICON_SVG,
        media_type="image/svg+xml",
        headers={"cache-control": "public, max-age=86400"},
    )


@app.get("/robots.txt", include_in_schema=False)
def robots_txt():
    return Response(
        content="User-agent: *\nDisallow: /\n",
        media_type="text/plain",
        headers={"cache-control": "public, max-age=86400"},
    )


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


def _etag_for(basis: str) -> str:
    return 'W/"' + hashlib.md5(basis.encode("utf-8")).hexdigest() + '"'


def _bins_list_etag(bins: list[dict]) -> str:
    basis = "|".join(f"{b['id']}:{b['message_count']}:{b['last_message_at']}" for b in bins)
    return _etag_for(basis)


@app.get("/api/bins")
def api_bins(request: Request):
    bins = db.list_bins()
    etag = _bins_list_etag(bins)
    headers = {"etag": etag, "cache-control": "no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse({"bins": bins}, headers=headers)


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


DASHBOARD_BOOTSTRAP_LIMIT = 25


@app.get("/bins/{bin_id}", response_class=HTMLResponse)
def bin_dashboard(request: Request, bin_id: str):
    bin_data = db.get_bin(bin_id)
    if not bin_data:
        raise HTTPException(status_code=404, detail="Bin not found")
    messages, next_before_id = db.list_messages(bin_id, limit=DASHBOARD_BOOTSTRAP_LIMIT)
    bootstrap = {
        "bin": bin_data,
        "messages": messages,
        "next_before_id": next_before_id,
    }
    # Escape "<" so the JSON payload can't break out of the inline <script> tag
    # (e.g. via a stored message body containing "</script>").
    bootstrap_json = json.dumps(bootstrap, default=str).replace("<", "\\u003c")
    return TEMPLATES.TemplateResponse(
        request=request,
        name="bin.html",
        context={
            "bin": bin_data,
            "base_url": public_base_url(request),
            "bootstrap_messages_json": bootstrap_json,
            "bootstrap_page_size": DASHBOARD_BOOTSTRAP_LIMIT,
        },
    )


@app.get("/api/bins/{bin_id}/messages")
def api_messages(
    bin_id: str,
    request: Request,
    limit: int = 100,
    before_id: int | None = None,
    after_id: int | None = None,
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
    etag = _etag_for(
        f"{bin_id}:{bin_data['message_count']}:{bin_data['last_message_at']}:"
        f"{limit}:{before_id}:{after_id}:{method}:{q}:{header_key}:{header_value}:{since}:{until}"
    )
    headers = {"etag": etag, "cache-control": "no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    messages, next_before_id = db.list_messages(
        bin_id,
        limit=max(1, min(limit, 500)),
        before_id=before_id,
        after_id=after_id,
        method=method,
        query=q,
        header_key=header_key,
        header_value=header_value,
        since=since,
        until=until,
    )
    return JSONResponse(
        {
            "bin": bin_data,
            "messages": messages,
            "next_before_id": next_before_id,
        },
        headers=headers,
    )


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
    if not db.bin_exists(bin_id):
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
async def stream_messages(bin_id: str, request: Request, after_id: int = 0):
    if not db.bin_exists(bin_id):
        raise HTTPException(status_code=404, detail="Bin not found")
    queue: asyncio.Queue[dict[str, object]] = asyncio.Queue(maxsize=256)
    _STREAM_SUBSCRIBERS.setdefault(bin_id, set()).add(queue)

    async def event_gen():
        try:
            header_event_id = int(request.headers.get("last-event-id", "0") or "0")
        except ValueError:
            header_event_id = 0
        last_event_id = max(0, after_id, header_event_id)
        try:
            while True:
                missed_messages = db.list_messages_after(bin_id, after_id=last_event_id, limit=500)
                if not missed_messages:
                    break
                for message in missed_messages:
                    latest_id = int(message["id"])
                    last_event_id = latest_id
                    event = {
                        "type": "new_message",
                        "latest_id": latest_id,
                        "message": message,
                    }
                    yield f"id: {latest_id}\nevent: message\ndata: {json.dumps(event)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                latest_id = int(event["latest_id"])
                if latest_id <= last_event_id:
                    continue
                last_event_id = latest_id
                payload = json.dumps(event)
                yield f"id: {latest_id}\nevent: message\ndata: {payload}\n\n"
        finally:
            subscribers = _STREAM_SUBSCRIBERS.get(bin_id)
            if subscribers is not None:
                subscribers.discard(queue)
                if not subscribers:
                    _STREAM_SUBSCRIBERS.pop(bin_id, None)

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
    if not db.bin_exists(bin_id):
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
    publish_stream_message(bin_id, message)
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


@app.get("/api/visitors")
def api_visitors(limit: int = 200):
    return {"visitors": db.list_visitors(limit=max(1, min(limit, 1000)))}


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
