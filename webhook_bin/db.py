from __future__ import annotations

import base64
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


class ManagedConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            if exc_type is None:
                self.commit()
            else:
                self.rollback()
        finally:
            self.close()
        return False


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def database_path() -> Path:
    data_dir = Path("data")
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "webhook_bin.db"


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(database_path(), factory=ManagedConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def initialize() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS bins (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS webhook_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bin_id TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
                received_at TEXT NOT NULL,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                query_string TEXT NOT NULL,
                remote_addr TEXT,
                content_type TEXT,
                headers_json TEXT NOT NULL,
                body_text TEXT NOT NULL,
                body_base64 TEXT NOT NULL,
                signature_status TEXT,
                signature_details TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_webhook_messages_bin_id
                ON webhook_messages (bin_id);
            CREATE INDEX IF NOT EXISTS idx_webhook_messages_received_at
                ON webhook_messages (received_at);

            CREATE TABLE IF NOT EXISTS visitor_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                ip TEXT,
                user_agent TEXT,
                path TEXT NOT NULL,
                referer TEXT,
                status_code INTEGER,
                duration_ms INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_visitor_log_timestamp
                ON visitor_log (timestamp);
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info('webhook_messages')").fetchall()}
        if "signature_status" not in columns:
            conn.execute("ALTER TABLE webhook_messages ADD COLUMN signature_status TEXT")
        if "signature_details" not in columns:
            conn.execute("ALTER TABLE webhook_messages ADD COLUMN signature_details TEXT")


def create_bin(bin_id: str, name: str) -> dict[str, Any]:
    now = utc_now()
    with connect() as conn:
        conn.execute(
            "INSERT INTO bins (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (bin_id, name, now, now),
        )
    return get_bin(bin_id)


def list_bins() -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT
                b.id,
                b.name,
                b.created_at,
                b.updated_at,
                COUNT(m.id) AS message_count,
                MAX(m.received_at) AS last_message_at
            FROM bins b
            LEFT JOIN webhook_messages m ON m.bin_id = b.id
            GROUP BY b.id
            ORDER BY b.updated_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def get_bin(bin_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT
                b.id,
                b.name,
                b.created_at,
                b.updated_at,
                COUNT(m.id) AS message_count,
                MAX(m.received_at) AS last_message_at
            FROM bins b
            LEFT JOIN webhook_messages m ON m.bin_id = b.id
            WHERE b.id = ?
            GROUP BY b.id
            """,
            (bin_id,),
        ).fetchone()
    return dict(row) if row else None


def delete_bin(bin_id: str) -> bool:
    with connect() as conn:
        cursor = conn.execute("DELETE FROM bins WHERE id = ?", (bin_id,))
    return cursor.rowcount > 0


def touch_bin(bin_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE bins SET updated_at = ? WHERE id = ?",
            (utc_now(), bin_id),
        )


def store_message(
    bin_id: str,
    method: str,
    path: str,
    query_string: str,
    remote_addr: str | None,
    content_type: str | None,
    headers: dict[str, str],
    body: bytes,
    signature_status: str | None = None,
    signature_details: str | None = None,
) -> dict[str, Any]:
    body_text = body.decode("utf-8", errors="replace")
    body_base64 = base64.b64encode(body).decode("ascii")
    now = utc_now()
    with connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO webhook_messages (
                bin_id, received_at, method, path, query_string, remote_addr,
                content_type, headers_json, body_text, body_base64,
                signature_status, signature_details
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                bin_id,
                now,
                method,
                path,
                query_string,
                remote_addr,
                content_type,
                json.dumps(headers, sort_keys=True),
                body_text,
                body_base64,
                signature_status,
                signature_details,
            ),
        )
        conn.execute("UPDATE bins SET updated_at = ? WHERE id = ?", (now, bin_id))
        message_id = cursor.lastrowid
    return get_message(message_id)


def list_messages(
    bin_id: str,
    limit: int = 100,
    before_id: int | None = None,
    method: str | None = None,
    query: str | None = None,
    header_key: str | None = None,
    header_value: str | None = None,
    since: str | None = None,
    until: str | None = None,
) -> tuple[list[dict[str, Any]], int | None]:
    where_clauses = ["bin_id = ?"]
    params: list[Any] = [bin_id]
    if before_id is not None:
        where_clauses.append("id < ?")
        params.append(before_id)
    if method:
        where_clauses.append("method = ?")
        params.append(method.upper())
    if query:
        where_clauses.append("(path LIKE ? OR query_string LIKE ? OR body_text LIKE ? OR headers_json LIKE ?)")
        like = f"%{query}%"
        params.extend([like, like, like, like])
    if header_key:
        header_key_like = f'%"{header_key.lower()}":%'
        where_clauses.append("lower(headers_json) LIKE ?")
        params.append(header_key_like)
    if header_key and header_value:
        header_pair_like = f'%"{header_key.lower()}": "{header_value}"%'
        where_clauses.append("lower(headers_json) LIKE ?")
        params.append(header_pair_like.lower())
    if since:
        where_clauses.append("received_at >= ?")
        params.append(since)
    if until:
        where_clauses.append("received_at <= ?")
        params.append(until)

    sql = f"""
        SELECT
            id,
            bin_id,
            received_at,
            method,
            path,
            query_string,
            remote_addr,
            content_type,
            headers_json,
            body_text,
            body_base64,
            signature_status,
            signature_details
        FROM webhook_messages
        WHERE {' AND '.join(where_clauses)}
        ORDER BY id DESC
        LIMIT ?
    """
    params.append(limit + 1)
    with connect() as conn:
        rows = conn.execute(sql, tuple(params)).fetchall()
    next_before_id = None
    if len(rows) > limit:
        next_before_id = rows[limit - 1]["id"]
        rows = rows[:limit]
    return [row_to_message(row, include_body=False, slim=True) for row in rows], next_before_id


def get_message(message_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT
                id,
                bin_id,
                received_at,
                method,
                path,
                query_string,
                remote_addr,
                content_type,
                headers_json,
                body_text,
                body_base64,
                signature_status,
                signature_details
            FROM webhook_messages
            WHERE id = ?
            """,
            (message_id,),
        ).fetchone()
    return row_to_message(row, include_body=True) if row else None


def get_latest_message_id(bin_id: str) -> int:
    with connect() as conn:
        row = conn.execute(
            "SELECT MAX(id) AS latest_id FROM webhook_messages WHERE bin_id = ?",
            (bin_id,),
        ).fetchone()
    return int(row["latest_id"] or 0) if row else 0


def apply_retention(bin_id: str, max_messages: int | None = None, retention_days: int | None = None) -> None:
    with connect() as conn:
        if retention_days and retention_days > 0:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
            conn.execute(
                "DELETE FROM webhook_messages WHERE bin_id = ? AND received_at < ?",
                (bin_id, cutoff),
            )
        if max_messages and max_messages > 0:
            conn.execute(
                """
                DELETE FROM webhook_messages
                WHERE id IN (
                    SELECT id
                    FROM webhook_messages
                    WHERE bin_id = ?
                    ORDER BY id DESC
                    LIMIT -1 OFFSET ?
                )
                """,
                (bin_id, max_messages),
            )


def get_metrics() -> dict[str, int]:
    with connect() as conn:
        bins_total = conn.execute("SELECT COUNT(*) AS c FROM bins").fetchone()["c"]
        messages_total = conn.execute("SELECT COUNT(*) AS c FROM webhook_messages").fetchone()["c"]
    return {
        "bins_total": int(bins_total or 0),
        "messages_total": int(messages_total or 0),
    }


def backup_database(target_path: str) -> None:
    destination = Path(target_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path()) as source_conn:
        with sqlite3.connect(destination) as dest_conn:
            source_conn.backup(dest_conn)


def restore_database(source_path: str) -> None:
    source = Path(source_path)
    if not source.exists():
        raise FileNotFoundError(f"Backup file not found: {source}")
    with sqlite3.connect(source) as source_conn:
        with sqlite3.connect(database_path()) as dest_conn:
            source_conn.backup(dest_conn)


def row_to_message(row: sqlite3.Row, include_body: bool, slim: bool = False) -> dict[str, Any]:
    body_text = row["body_text"]
    content_type = (row["content_type"] or "").lower()

    if slim:
        # Lightweight card representation: no headers, no body_json, short preview
        return {
            "id": row["id"],
            "bin_id": row["bin_id"],
            "received_at": row["received_at"],
            "method": row["method"],
            "path": row["path"],
            "query_string": row["query_string"],
            "body_size": len(base64.b64decode(row["body_base64"])),
            "body_preview": body_text[:120],
            "has_json": "json" in content_type,
            "signature_status": row["signature_status"],
        }

    headers = json.loads(row["headers_json"]) if row["headers_json"] else {}
    body_json = None
    if "json" in content_type:
        try:
            body_json = json.loads(body_text)
        except json.JSONDecodeError:
            body_json = None
    message = {
        "id": row["id"],
        "bin_id": row["bin_id"],
        "received_at": row["received_at"],
        "method": row["method"],
        "path": row["path"],
        "query_string": row["query_string"],
        "remote_addr": row["remote_addr"],
        "content_type": row["content_type"],
        "headers": headers,
        "body_size": len(base64.b64decode(row["body_base64"])),
        "body_preview": body_text[:500],
        "signature_status": row["signature_status"],
        "signature_details": row["signature_details"],
    }
    if body_json is not None:
        message["body_json"] = body_json
    if include_body:
        message["body_text"] = body_text
        message["body_base64"] = row["body_base64"]
    return message


def log_visitor(
    ip: str | None,
    user_agent: str | None,
    path: str,
    referer: str | None,
    status_code: int,
    duration_ms: int,
) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO visitor_log (timestamp, ip, user_agent, path, referer, status_code, duration_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (utc_now(), ip, user_agent, path, referer, status_code, duration_ms),
        )


def list_visitors(limit: int = 200) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, timestamp, ip, user_agent, path, referer, status_code, duration_ms
            FROM visitor_log
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]
    headers = json.loads(row["headers_json"]) if row["headers_json"] else {}
    body_text = row["body_text"]
    body_json = None
    content_type = (row["content_type"] or "").lower()
    if "json" in content_type:
        try:
            body_json = json.loads(body_text)
        except json.JSONDecodeError:
            body_json = None
    message = {
        "id": row["id"],
        "bin_id": row["bin_id"],
        "received_at": row["received_at"],
        "method": row["method"],
        "path": row["path"],
        "query_string": row["query_string"],
        "remote_addr": row["remote_addr"],
        "content_type": row["content_type"],
        "headers": headers,
        "body_size": len(base64.b64decode(row["body_base64"])),
        "body_preview": body_text[:500],
        "signature_status": row["signature_status"],
        "signature_details": row["signature_details"],
    }
    if body_json is not None:
        message["body_json"] = body_json
    if include_body:
        message["body_text"] = body_text
        message["body_base64"] = row["body_base64"]
    return message
