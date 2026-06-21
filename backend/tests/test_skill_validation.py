"""Regression tests for agent skill validation.

Guards the 海报设计师 incident (2026-05/06): _skills_root() pointed at a
nonexistent directory (wrong parents[] depth), so _discover_skills() returned []
and every agent saved via the UI had ALL its skills silently stripped.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch


def test_skills_root_fallback_resolves_to_sibling_core_skills():
    """Without an override, _skills_root() must resolve to goku/core/skills.

    Skills are owned by goku-core; this Studio repo is a sibling checkout, so the
    default is the sibling ``core/skills``. A regression to parents[3] would point
    at this repo's ``backend/skills`` (nonexistent) → empty discovery → skill wipe.
    """
    from app.routers.studio.agents import _skills_root

    with patch.dict("os.environ", {}, clear=False):
        import os
        os.environ.pop("SKILLS_ROOT", None)
        root = _skills_root()

    assert root.name == "skills"
    assert root.parent.name == "core", (
        f"_skills_root() should resolve under goku/core/, got {root}"
    )
    assert root.parent.name != "backend"  # the original parents[3] bug


def test_skills_root_honours_override(tmp_path: Path):
    from app.routers.studio.agents import _skills_root

    with patch.dict("os.environ", {"SKILLS_ROOT": str(tmp_path / "s")}, clear=False):
        assert _skills_root() == tmp_path / "s"


def test_filter_valid_skills_is_failsafe_when_no_skills_discoverable():
    """Empty valid set means 'cannot validate here' — keep submitted skills as-is.

    This is the core data-loss guard: the Studio service does not own the skill
    files, so an empty discovery must NEVER wipe an agent's skill bindings.
    """
    from app.routers.studio.agents import _filter_valid_skills

    with patch("app.routers.studio.agents._valid_skill_ids", return_value=set()):
        assert _filter_valid_skills(["poster-design-skill", "x"]) == ["poster-design-skill", "x"]


def test_filter_valid_skills_filters_when_set_known():
    from app.routers.studio.agents import _filter_valid_skills

    with patch("app.routers.studio.agents._valid_skill_ids", return_value={"a", "c"}):
        assert _filter_valid_skills(["a", "b", "c"]) == ["a", "c"]


def test_filter_valid_skills_handles_none_and_blanks():
    from app.routers.studio.agents import _filter_valid_skills

    with patch("app.routers.studio.agents._valid_skill_ids", return_value=set()):
        assert _filter_valid_skills(None) == []
        assert _filter_valid_skills(["", "ok"]) == ["ok"]
