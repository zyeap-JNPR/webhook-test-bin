from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from webhook_bin import db
from webhook_bin import main


def test_index_page_renders(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "Catch and inspect webhook data" in res.text


def test_favicon_and_robots_routes(client):
    favicon_svg = client.get("/favicon.svg")
    assert favicon_svg.status_code == 200
    assert "image/svg+xml" in favicon_svg.headers["content-type"]

    favicon_ico = client.get("/favicon.ico")
    assert favicon_ico.status_code == 204

    robots = client.get("/robots.txt")
    assert robots.status_code == 200
    assert "User-agent: *" in robots.text


def test_create_bin_defaults_and_invalid_json(client):
    created = client.post("/api/bins")
    assert created.status_code == 201
    assert created.json()["bin"]["name"] == "Default bin"

    invalid = client.post(
        "/api/bins",
        data="invalid-json",
        headers={"content-type": "application/json"},
    )
    assert invalid.status_code == 400
    assert invalid.json()["detail"] == "Invalid JSON body"

    non_object = client.post(
        "/api/bins",
        content=json.dumps(["x"]),
        headers={"content-type": "application/json"},
    )
    assert non_object.status_code == 400
    assert non_object.json()["detail"] == "Body must be a JSON object"


def test_api_bins_and_bin_detail(client):
    create = client.post("/api/bins", json={"name": "alpha"})
    bin_id = create.json()["bin"]["id"]

    bins = client.get("/api/bins")
    assert bins.status_code == 200
    assert any(b["id"] == bin_id for b in bins.json()["bins"])

    detail = client.get(f"/api/bins/{bin_id}")
    assert detail.status_code == 200
    assert detail.json()["bin"]["id"] == bin_id

    missing = client.get("/api/bins/missing")
    assert missing.status_code == 404


def test_delete_bin_api_and_redirect_route(client):
    created = client.post("/api/bins", json={"name": "to-delete"})
    bin_id = created.json()["bin"]["id"]

    deleted = client.delete(f"/api/bins/{bin_id}")
    assert deleted.status_code == 200
    assert deleted.json() == {"status": "deleted", "bin_id": bin_id}
    assert client.get(f"/api/bins/{bin_id}").status_code == 404

    missing = client.delete("/api/bins/missing")
    assert missing.status_code == 404

    created2 = client.post("/api/bins", json={"name": "to-delete-redirect"})
    bin2 = created2.json()["bin"]["id"]
    redirected = client.post(f"/delete/{bin2}", follow_redirects=False)
    assert redirected.status_code == 303
    assert redirected.headers["location"] == "/"
    assert client.get(f"/api/bins/{bin2}").status_code == 404


def test_bin_dashboard_and_messages_not_found(client):
    dash_missing = client.get("/bins/missing")
    assert dash_missing.status_code == 404

    msgs_missing = client.get("/api/bins/missing/messages")
    assert msgs_missing.status_code == 404

    msg_missing = client.get("/api/messages/999999")
    assert msg_missing.status_code == 404

    created = client.post("/api/bins", json={"name": "dash-ok"})
    ok_dash = client.get(f"/bins/{created.json()['bin']['id']}")
    assert ok_dash.status_code == 200


def test_ingest_hook_and_message_retrieval(client):
    create = client.post("/api/bins", json={"name": "ingest"})
    bin_id = create.json()["bin"]["id"]

    send = client.post(
        f"/hooks/{bin_id}",
        json={"event": "unit"},
        headers={"x-unit": "yes"},
    )
    assert send.status_code == 201
    message_id = send.json()["message"]["id"]

    messages = client.get(f"/api/bins/{bin_id}/messages")
    assert messages.status_code == 200
    assert len(messages.json()["messages"]) == 1
    assert messages.json()["messages"][0]["id"] == message_id

    message = client.get(f"/api/messages/{message_id}")
    assert message.status_code == 200
    assert message.json()["message"]["headers"]["x-unit"] == "yes"
    assert message.json()["message"]["body_json"]["event"] == "unit"


def test_ingest_signature_verification(client, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main, "HMAC_SECRET", b"top-secret")
    create = client.post("/api/bins", json={"name": "signed"})
    bin_id = create.json()["bin"]["id"]
    body = b'{"event":"signed"}'
    sig = hmac.new(b"top-secret", body, hashlib.sha256).hexdigest()
    sent = client.post(
        f"/hooks/{bin_id}",
        content=body,
        headers={"content-type": "application/json", "x-signature-sha256": sig},
    )
    assert sent.status_code == 201
    assert sent.json()["message"]["signature_status"] == "verified"


def test_ingest_response_is_minimal_ack(client):
    create = client.post("/api/bins", json={"name": "ack"})
    bin_id = create.json()["bin"]["id"]

    send = client.post(
        f"/hooks/{bin_id}",
        json={"event": "unit", "secret_field": "should-not-echo"},
        headers={"x-unit": "yes"},
    )
    assert send.status_code == 201
    ack = send.json()["message"]
    assert set(ack.keys()) == {"id", "bin_id", "received_at", "signature_status"}
    assert ack["bin_id"] == bin_id
    # The ingest ack must not echo the payload, headers, or encoded body back.
    for leaked in ("body_text", "body_base64", "body_json", "body_preview", "headers"):
        assert leaked not in ack


def test_ingest_signature_verification_mist_v2(client, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main, "HMAC_SECRET", b"mist-secret")
    create = client.post("/api/bins", json={"name": "mist"})
    bin_id = create.json()["bin"]["id"]
    body = b'{"topic":"audits"}'
    sig = hmac.new(b"mist-secret", body, hashlib.sha256).hexdigest()
    sent = client.post(
        f"/hooks/{bin_id}",
        content=body,
        headers={"content-type": "application/json", "x-mist-signature-v2": sig},
    )
    assert sent.status_code == 201
    assert sent.json()["message"]["signature_status"] == "verified"


def test_list_messages_returns_slim_shape(client):
    """List endpoint must return slim card shape: no headers/body_json, has has_json, short preview."""
    create = client.post("/api/bins", json={"name": "slim-list"})
    bin_id = create.json()["bin"]["id"]

    client.post(f"/hooks/{bin_id}", json={"topic": "audits", "events": [{"msg": "x" * 200}]})

    res = client.get(f"/api/bins/{bin_id}/messages?limit=10")
    assert res.status_code == 200
    messages = res.json()["messages"]
    assert len(messages) == 1
    msg = messages[0]

    # slim fields present
    assert "has_json" in msg
    assert msg["has_json"] is True
    assert "body_preview" in msg
    assert len(msg["body_preview"]) <= 120

    # full-detail fields absent from list
    for key in ("headers", "body_json", "body_text", "body_base64"):
        assert key not in msg, f"{key} should not be in list response"



    create = client.post("/api/bins", json={"name": "methods"})
    bin_id = create.json()["bin"]["id"]
    for method in ("put", "patch", "delete", "options"):
        res = client.request(method.upper(), f"/hooks/{bin_id}", content="x")
        assert res.status_code == 201


def test_ingest_missing_bin_returns_404(client):
    res = client.post("/hooks/missing", content="x", headers={"content-type": "text/plain"})
    assert res.status_code == 404


def test_ingest_rejects_invalid_content_length(client):
    create = client.post("/api/bins", json={"name": "length"})
    bin_id = create.json()["bin"]["id"]
    res = client.post(
        f"/hooks/{bin_id}",
        content="abc",
        headers={"content-type": "text/plain", "content-length": "abc"},
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "Invalid Content-Length header"


def test_ingest_rejects_payload_too_large_by_header(client, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main, "MAX_BODY_BYTES", 4)
    create = client.post("/api/bins", json={"name": "size"})
    bin_id = create.json()["bin"]["id"]
    res = client.post(
        f"/hooks/{bin_id}",
        content="abcdef",
        headers={"content-type": "text/plain"},
    )
    assert res.status_code == 413
    assert res.json()["detail"] == "Payload too large"


def test_ingest_rejects_payload_too_large_by_body_without_content_length(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(db, "database_path", lambda: tmp_path / "direct.db")
    db.initialize()
    db.create_bin("direct", "direct")
    monkeypatch.setattr(main, "MAX_BODY_BYTES", 4)

    class FakeReq:
        headers = {}
        method = "POST"
        url = SimpleNamespace(path="/hooks/direct", query="")
        client = SimpleNamespace(host="127.0.0.1")

        async def body(self):
            return b"012345"

    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.ingest_hook("direct", FakeReq()))
    assert exc.value.status_code == 413
    assert exc.value.detail == "Payload too large"


def test_seed_bin_creates_message_and_redirects(client):
    create = client.post("/api/bins", json={"name": "seed"})
    bin_id = create.json()["bin"]["id"]
    seed = client.post(f"/api/bins/{bin_id}/seed", follow_redirects=False)
    assert seed.status_code == 303
    assert seed.headers["location"] == f"/bins/{bin_id}"

    messages = client.get(f"/api/bins/{bin_id}/messages")
    assert len(messages.json()["messages"]) == 1


def test_seed_missing_bin_returns_404(client):
    res = client.post("/api/bins/missing/seed")
    assert res.status_code == 404


def test_healthz(client):
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_metrics(client):
    res = client.get("/metrics")
    assert res.status_code == 200
    assert "webhook_bin_bins_total" in res.text
    assert "webhook_bin_messages_total" in res.text


def test_api_messages_limit_is_clamped(client):
    create = client.post("/api/bins", json={"name": "limit"})
    bin_id = create.json()["bin"]["id"]
    for i in range(3):
        client.post(f"/hooks/{bin_id}", content=f"m{i}", headers={"content-type": "text/plain"})

    with patch("webhook_bin.main.db.list_messages", wraps=db.list_messages) as wrapped:
        client.get(f"/api/bins/{bin_id}/messages?limit=10000")
        assert wrapped.call_args.kwargs["limit"] == 500


def test_api_messages_cursor_and_filters(client):
    create = client.post("/api/bins", json={"name": "cursor"})
    bin_id = create.json()["bin"]["id"]
    client.post(f"/hooks/{bin_id}", content="hello alpha", headers={"content-type": "text/plain", "x-type": "a"})
    client.request("PUT", f"/hooks/{bin_id}", content="hello beta", headers={"content-type": "text/plain", "x-type": "b"})
    first = client.get(f"/api/bins/{bin_id}/messages?limit=1")
    assert first.status_code == 200
    assert len(first.json()["messages"]) == 1
    assert first.json()["next_before_id"] is not None

    before_id = first.json()["next_before_id"]
    second = client.get(f"/api/bins/{bin_id}/messages?limit=1&before_id={before_id}")
    assert second.status_code == 200
    assert len(second.json()["messages"]) == 1

    filtered = client.get(f"/api/bins/{bin_id}/messages?method=PUT&q=beta")
    assert filtered.status_code == 200
    assert all(message["method"] == "PUT" for message in filtered.json()["messages"])


def test_export_endpoints(client):
    create = client.post("/api/bins", json={"name": "exports"})
    bin_id = create.json()["bin"]["id"]
    sent = client.post(
        f"/hooks/{bin_id}",
        json={"hello": "world"},
        headers={"x-demo": "yes"},
    )
    msg_id = sent.json()["message"]["id"]

    export = client.get(f"/api/messages/{msg_id}/export")
    assert export.status_code == 200
    assert "attachment;" in export.headers["content-disposition"]

    curl_export = client.get(f"/api/messages/{msg_id}/curl")
    assert curl_export.status_code == 200
    assert "curl -X POST" in curl_export.text

    ndjson = client.get(f"/api/bins/{bin_id}/export.ndjson")
    assert ndjson.status_code == 200
    assert f"\"bin_id\": \"{bin_id}\"" in ndjson.text


def test_visitor_log_records_page_visits(client):
    # Dashboard page load should be logged
    client.get("/")
    visitors = client.get("/api/visitors")
    assert visitors.status_code == 200
    entries = visitors.json()["visitors"]
    assert len(entries) >= 1
    visit = entries[0]
    assert visit["path"] == "/"
    assert visit["status_code"] == 200
    assert "timestamp" in visit
    assert "duration_ms" in visit


def test_visitor_log_skips_noise_paths(client):
    initial = len(client.get("/api/visitors").json()["visitors"])
    # These should not be logged
    client.get("/healthz")
    client.get("/metrics")
    client.get("/api/bins")
    client.get("/favicon.svg")
    after = len(client.get("/api/visitors").json()["visitors"])
    # /api/visitors itself should also not be logged; no new rows from noise paths
    assert after == initial


def test_stream_endpoint(client):
    db.create_bin("stream01", "stream")

    class FakeRequest:
        headers = {}

        async def is_disconnected(self):
            return True

    response = asyncio.run(main.stream_messages("stream01", FakeRequest()))
    assert response.status_code == 200
    assert response.media_type == "text/event-stream"


def test_public_base_url_prefers_env(client, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://public.test")
    created = client.post("/api/bins", json={"name": "url"})
    assert created.json()["ingest_url"].startswith("https://public.test/")


def test_base_url_and_public_base_url_helpers(monkeypatch: pytest.MonkeyPatch):
    request = SimpleNamespace(base_url="http://127.0.0.1:8000/")
    monkeypatch.delenv("PUBLIC_BASE_URL", raising=False)
    assert main.base_url(request) == "http://127.0.0.1:8000"
    assert main.public_base_url(request) == "http://127.0.0.1:8000"
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://x.test")
    assert main.public_base_url(request) == "https://x.test"


def test_main_calls_uvicorn_with_defaults(monkeypatch: pytest.MonkeyPatch):
    captured = {}

    def fake_run(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs

    monkeypatch.delenv("WEBHOOK_BIN_HOST", raising=False)
    monkeypatch.delenv("WEBHOOK_BIN_PORT", raising=False)
    monkeypatch.delenv("WEBHOOK_BIN_RELOAD", raising=False)
    monkeypatch.delenv("WEBHOOK_BIN_FORWARDED_ALLOW_IPS", raising=False)
    monkeypatch.setattr(main.sys, "argv", ["webhook-bin"])
    with patch("uvicorn.run", side_effect=fake_run):
        main.main()

    assert captured["args"][0] == "webhook_bin.main:app"
    assert captured["kwargs"]["host"] == "0.0.0.0"
    assert captured["kwargs"]["port"] == 8000
    assert captured["kwargs"]["reload"] is False
    assert captured["kwargs"]["forwarded_allow_ips"] == "127.0.0.1,::1"


def test_make_bin_id_length():
    generated = main.make_bin_id()
    assert isinstance(generated, str)
    assert len(generated) == 8


def test_main_backup_and_restore_commands(monkeypatch: pytest.MonkeyPatch):
    backup_called = {}
    restore_called = {}

    monkeypatch.setattr(main.db, "initialize", lambda: None)
    monkeypatch.setattr(main.db, "backup_database", lambda path: backup_called.setdefault("path", path))
    monkeypatch.setattr(main.db, "restore_database", lambda path: restore_called.setdefault("path", path))

    monkeypatch.setattr(main.sys, "argv", ["webhook-bin", "backup", "/tmp/backup.db"])
    main.main()
    assert backup_called["path"] == "/tmp/backup.db"

    monkeypatch.setattr(main.sys, "argv", ["webhook-bin", "restore", "/tmp/backup.db"])
    main.main()
    assert restore_called["path"] == "/tmp/backup.db"
