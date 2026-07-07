from __future__ import annotations


class _NoAgentQuery:
    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return None


class _Db:
    def query(self, _model):
        return _NoAgentQuery()


def test_workflow_portable_key_is_stable_for_ascii_name():
    from app.routers.studio.workflows import _workflow_portable_key

    assert _workflow_portable_key("Shareholder Voice Report") == "shareholder-voice-report"


def test_workflow_portable_key_is_stable_for_cjk_name():
    from app.routers.studio.workflows import _workflow_portable_key

    assert _workflow_portable_key("股民心声分析报告") == _workflow_portable_key("股民心声分析报告")
    assert _workflow_portable_key("股民心声分析报告").startswith("workflow-")


def test_workflow_export_includes_key_in_payload_and_variables():
    from app.routers.studio.workflows import _build_workflow_export_payload

    workflow = type("Workflow", (), {
        "id": "wf-1",
        "name": "Shareholder Voice Report",
        "description": "desc",
        "dag": {"nodes": [], "edges": []},
        "triggers": [],
        "variables": {},
        "agent_id": None,
    })()

    payload = _build_workflow_export_payload(workflow, _Db())

    assert payload["workflow"]["workflow_key"] == "shareholder-voice-report"
    assert payload["workflow"]["variables"]["_workflow_key"] == "shareholder-voice-report"
