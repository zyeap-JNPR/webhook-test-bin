from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from webhook_bin import db
from webhook_bin.main import app


@pytest.fixture
def temp_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    db_file = tmp_path / "webhook_test.db"
    monkeypatch.setattr(db, "database_path", lambda: db_file)
    db.initialize()
    return db_file


@pytest.fixture
def client(temp_db: Path) -> TestClient:
    with TestClient(app) as test_client:
        yield test_client
