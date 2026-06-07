"""
goku-studio test configuration.

Sets up a minimal environment so that importing goku_shared.db at
collection time does not require a real DATABASE_URL.  Tests that
actually need DB access should use the `db_session` fixture below.
"""
from __future__ import annotations

import os
import pytest

# ── Provide a SQLite in-memory DATABASE_URL before any module imports it ──────
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-studio-tests-only")
os.environ.setdefault("OPENAI_API_KEY", "test-key")


# ── Optional: in-memory DB session for tests that need it ─────────────────────

@pytest.fixture(scope="session")
def db_engine():
    """SQLAlchemy engine backed by SQLite in-memory (session-scoped)."""
    from sqlalchemy import create_engine
    from goku_shared.db import Base

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def db_session(db_engine):
    """Per-test transactional session that rolls back after each test."""
    from sqlalchemy.orm import sessionmaker

    Session = sessionmaker(bind=db_engine)
    session = Session()
    try:
        yield session
    finally:
        session.rollback()
        session.close()
