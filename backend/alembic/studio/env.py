import os
from logging.config import fileConfig
from sqlalchemy import engine_from_config, pool
from alembic import context

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

"""
Alembic env.py for the Studio domain migration chain.

This chain manages tables owned by goku-studio:
  agent_definitions, agent_access_policies, user_agent_favorites,
  workflows, workflow_executions, workflow_node_executions,
  tools, auto_skills, plugins, mcp_servers, mcp_capabilities,
  mcp_resources, mcp_prompts, mcp_*, knowledge_docs, doc_pages,
  external_memory_sources, ira_*, improvement_proposals,
  proposal_outcomes, prompt_experiments, tool_call_stats.

The first migration in this chain sets:
  down_revision = "0086"   (shared baseline endpoint)
"""

database_url = os.environ.get("DATABASE_URL")
if not database_url:
    raise RuntimeError("DATABASE_URL environment variable is required for Alembic migrations")
config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))

# Import Studio models only.
# Core/Admin/Channels models are intentionally excluded — autogenerate must
# not propose changes to Core-owned tables when running Studio migrations.
from app.db import Base
import app.models_studio  # noqa: F401

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
