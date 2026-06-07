"""
Database session — re-exports from goku_shared.db.

During monorepo transition: this file mirrors backend/app/db.py.
Once goku-shared is published as a package, callers can import directly
from goku_shared.db — this shim stays for backward compat.
"""
from goku_shared.db import Base, engine, SessionLocal, get_db  # noqa: F401
