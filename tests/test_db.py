from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from webhook_bin import db


def _tables(db_file: Path) -> set[str]:
    conn = sqlite3.connect(db_file)
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    conn.close()
    return {row[0] for row in rows}


def test_initialize_creates_tables_and_index(temp_db: Path):
    tables = _tables(temp_db)
    assert "bins" in tables
    assert "webhook_messages" in tables

    conn = sqlite3.connect(temp_db)
    idx_rows = conn.execute("PRAGMA index_list('webhook_messages')").fetchall()
    conn.close()
    idx_names = {row[1] for row in idx_rows}
    assert "idx_webhook_messages_bin_id" in idx_names


def test_create_and_get_bin(temp_db: Path):
    created = db.create_bin("abc123", "alpha")
    assert created["id"] == "abc123"
    assert created["name"] == "alpha"
    assert created["message_count"] == 0
    assert created["last_message_at"] is None

    fetched = db.get_bin("abc123")
    assert fetched is not None
    assert fetched["id"] == "abc123"


def test_delete_bin_removes_bin_and_messages(temp_db: Path):
    db.create_bin("drop1", "drop")
    db.store_message(
        bin_id="drop1",
        method="POST",
        path="/hooks/drop1",
        query_string="",
        remote_addr=None,
        content_type="text/plain",
        headers={},
        body=b"payload",
    )
    assert db.delete_bin("drop1") is True
    assert db.get_bin("drop1") is None
    rows, cursor = db.list_messages("drop1")
    assert rows == []
    assert cursor is None
    assert db.delete_bin("drop1") is False


def test_list_bins_sorts_by_updated_at(temp_db: Path):
    db.create_bin("one", "one")
    db.create_bin("two", "two")
    db.store_message(
        bin_id="one",
        method="POST",
        path="/hooks/one",
        query_string="",
        remote_addr="127.0.0.1",
        content_type="application/json",
        headers={"content-type": "application/json"},
        body=b'{"x":1}',
    )
    bins = db.list_bins()
    assert bins[0]["id"] == "one"
    assert bins[0]["message_count"] == 1


def test_store_and_get_message_json_parsing(temp_db: Path):
    db.create_bin("b1", "bin")
    stored = db.store_message(
        bin_id="b1",
        method="POST",
        path="/hooks/b1",
        query_string="a=1",
        remote_addr="1.2.3.4",
        content_type="application/json",
        headers={"x-k": "v"},
        body=b'{"event":"ok"}',
    )
    assert stored["id"] > 0
    assert stored["body_json"] == {"event": "ok"}
    assert stored["body_size"] == len(b'{"event":"ok"}')

    fetched = db.get_message(stored["id"])
    assert fetched is not None
    assert fetched["query_string"] == "a=1"
    assert fetched["body_text"] == '{"event":"ok"}'
    assert "body_base64" in fetched


def test_store_non_json_body_has_no_body_json(temp_db: Path):
    db.create_bin("b2", "bin")
    stored = db.store_message(
        bin_id="b2",
        method="POST",
        path="/hooks/b2",
        query_string="",
        remote_addr=None,
        content_type="text/plain",
        headers={},
        body=b"plain",
    )
    assert "body_json" not in stored


def test_json_content_with_invalid_json_body_has_no_body_json(temp_db: Path):
    db.create_bin("b2j", "bin")
    stored = db.store_message(
        bin_id="b2j",
        method="POST",
        path="/hooks/b2j",
        query_string="",
        remote_addr=None,
        content_type="application/json",
        headers={},
        body=b"{not-json}",
    )
    assert "body_json" not in stored


def test_list_messages_limit_and_preview(temp_db: Path):
    db.create_bin("b3", "bin")
    for i in range(5):
        db.store_message(
            bin_id="b3",
            method="POST",
            path="/hooks/b3",
            query_string="",
            remote_addr=None,
            content_type="text/plain",
            headers={},
            body=f"msg-{i}".encode(),
        )
    rows, next_before_id = db.list_messages("b3", limit=3)
    assert len(rows) == 3
    assert rows[0]["body_preview"] == "msg-4"
    assert next_before_id is not None


def test_touch_bin_updates_updated_at(temp_db: Path):
    db.create_bin("b4", "bin")
    before = db.get_bin("b4")
    assert before is not None
    db.touch_bin("b4")
    after = db.get_bin("b4")
    assert after is not None
    assert after["updated_at"] >= before["updated_at"]


def test_database_path_creates_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(tmp_path)
    path = db.database_path()
    assert path.name == "webhook_bin.db"
    assert path.parent.name == "data"
    assert path.parent.exists()


def test_managed_connection_rolls_back_and_closes_on_exception(temp_db: Path):
    conn = db.connect()
    with pytest.raises(RuntimeError):
        with conn:
            conn.execute("CREATE TABLE temp_t (id INTEGER)")
            raise RuntimeError("boom")
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_list_messages_filters(temp_db: Path):
    db.create_bin("flt1", "filters")
    db.store_message(
        bin_id="flt1",
        method="POST",
        path="/hooks/flt1",
        query_string="",
        remote_addr=None,
        content_type="application/json",
        headers={"x-kind": "alpha"},
        body=b'{"kind":"alpha"}',
    )
    db.store_message(
        bin_id="flt1",
        method="PUT",
        path="/hooks/flt1",
        query_string="",
        remote_addr=None,
        content_type="text/plain",
        headers={"x-kind": "beta"},
        body=b"beta body",
    )
    rows, _ = db.list_messages("flt1", method="POST", query="alpha")
    assert len(rows) == 1
    assert rows[0]["method"] == "POST"


def test_backup_and_restore_database(temp_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db.create_bin("bak1", "backup")
    backup_path = tmp_path / "backup" / "webhook.db"
    db.backup_database(str(backup_path))
    assert backup_path.exists()

    restored_db = tmp_path / "restored.db"
    monkeypatch.setattr(db, "database_path", lambda: restored_db)
    db.restore_database(str(backup_path))
    db.initialize()
    restored = db.get_bin("bak1")
    assert restored is not None


def test_retention_max_messages(temp_db: Path):
    db.create_bin("ret1", "retention")
    for i in range(5):
        db.store_message(
            bin_id="ret1",
            method="POST",
            path="/hooks/ret1",
            query_string="",
            remote_addr=None,
            content_type="text/plain",
            headers={},
            body=f"m{i}".encode(),
        )
    db.apply_retention("ret1", max_messages=2)
    rows, _ = db.list_messages("ret1", limit=10)
    assert len(rows) == 2
