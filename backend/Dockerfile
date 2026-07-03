FROM python:3.11-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmagic1 curl git \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 + uv runtimes — Studio's MCP server test/sync spawns the same
# stdio MCP subprocesses as core: `npx -y <pkg>` presets (mysql, github, …)
# need node, and `uvx <pkg>` presets (the official ClickHouse server
# `uvx mcp-clickhouse`) need uv. Without them every npx/uvx-based server
# fails at spawn time with "Connection closed".
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/* && \
    node --version && npx --version
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Install goku-shared
COPY packages/goku-shared /goku-shared
RUN pip install -e /goku-shared

# Install Studio deps
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY backend/ .

ENV PORT=8107
EXPOSE 8107

CMD ["sh", "-c", \
     "alembic -c alembic/studio/alembic.ini upgrade head && \
      uvicorn app.main:app --host 0.0.0.0 --port $PORT"]
