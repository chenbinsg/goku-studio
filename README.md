# Goku Studio — AI Application Construction API

> Owner: **智能体应用チーム**  
> Status: Stub (being extracted from monorepo)

This repo owns the **Studio domain**: building and managing AI agents, workflows,
tools, MCP server connections, knowledge bases, and memory profiles.

It does **not** own:
- Task execution / ReAct loop → **goku-core**
- Users / tenants / auth → **goku-core**
- Chat / conversations → **goku-core**
- Channel integrations → **goku-core**

## Architecture

```
goku-studio/
  backend/
    app/
      main.py               ← FastAPI app, mounts /api/studio/v1
      models_studio.py      ← Studio ORM (symlink or copy from monorepo during transition)
      routers/studio/       ← 18 router files
      schemas/              ← Studio-specific Pydantic schemas
    alembic/studio/         ← Studio migration chain (starts from baseline 0086)
    requirements.txt
    Makefile

packages/goku-shared/       ← Shared dep: db, config, auth, schemas (separate repo)
```

## Dependencies

- `goku-shared` — database, config, JWT auth primitives
- Same MySQL database as goku-core (shared DB strategy, Phase B)
- Studio tables: `agent_definitions`, `workflows`, `tools`, `mcp_servers`, `knowledge_docs`, ...

## Running locally

```bash
# Install deps (including goku-shared from local path during development)
pip install -e ../../packages/goku-shared
pip install -r requirements.txt

# Set env vars
export DATABASE_URL=mysql+pymysql://user:pass@localhost:3306/aios
export SECRET_KEY=your-secret-key

# Apply migrations (run shared baseline first if fresh DB)
make migrate

# Start API
uvicorn app.main:app --host 0.0.0.0 --port 8107 --reload
```

## Migration workflow

```bash
# Create a new Studio migration
make migration-new name="add new_field to agent_definitions"

# Apply
make migrate
```

## Extraction status

- [x] Step 1: models_studio.py isolated
- [x] Step 2: alembic/studio/ domain chain ready
- [x] Step 3: goku-shared package created
- [x] Step 4: This stub repo created
- [x] Phase B: Symlink/copy routers/studio/ into this repo
- [x] Phase B: CI green with Studio-only imports (6/6 boundary tests pass)
- [ ] Phase C: Frontend `VITE_STUDIO_API_URL` points here
- [ ] Phase D: Remove Studio files from goku-core
