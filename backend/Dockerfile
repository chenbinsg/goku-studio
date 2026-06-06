FROM python:3.11-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmagic1 curl \
    && rm -rf /var/lib/apt/lists/*

# Install goku-shared (pinned release in production; local editable during dev)
# COPY ../../packages/goku-shared /goku-shared
# RUN pip install -e /goku-shared
RUN pip install --no-cache-dir goku-shared==0.1.0

# Install Studio deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

ENV PORT=8107
EXPOSE 8107

CMD ["sh", "-c", \
     "alembic -c alembic/studio/alembic.ini upgrade head && \
      uvicorn app.main:app --host 0.0.0.0 --port $PORT"]
