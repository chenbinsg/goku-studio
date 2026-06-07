.PHONY: migrate migration-new seed-agents deploy

## Apply all pending Studio migrations.
## Run the shared baseline (0046–0086) first if this is a fresh DB.
migrate:
	alembic -c alembic/studio/alembic.ini upgrade head

## Generate a new Studio migration: make migration-new name="add xyz"
migration-new:
	alembic -c alembic/studio/alembic.ini revision --autogenerate -m "$(name)"

## Upsert Studio agent seeds
seed-agents:
	python scripts/seed_agents.py

## Full Studio deploy: migrate + seed
deploy: migrate seed-agents

## Run Studio tests only
test:
	pytest tests/ -q --tb=short
