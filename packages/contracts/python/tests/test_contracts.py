from __future__ import annotations

import json
from pathlib import Path

from search_agent_v2 import (
    CONTRACT_ERROR_CODES,
    SearchAgentV2ContractValidator,
    contains_private_reasoning,
    contracts_root,
)


def load_manifest() -> dict:
    return json.loads((contracts_root() / "fixtures" / "manifest.json").read_text(encoding="utf-8"))


def test_manifest_fixtures_match_expected_results() -> None:
    validator = SearchAgentV2ContractValidator()
    manifest = load_manifest()
    assert manifest["schemaVersion"] == "2.0"
    assert tuple(manifest["errorCodes"]) == CONTRACT_ERROR_CODES
    assert len(manifest["entries"]) > 100
    assert len({entry["id"] for entry in manifest["entries"]}) == len(manifest["entries"])
    for entry in manifest["entries"]:
        result = validator.validate_fixture(entry)
        assert result.valid is entry["expectedValid"], entry["id"]
        assert result.error_code == entry["expectedErrorCode"], entry["id"]


def test_manifest_covers_every_fixture_exactly_once() -> None:
    fixture_root = contracts_root() / "fixtures"
    listed = sorted(entry["path"] for entry in load_manifest()["entries"])
    files = sorted(
        str(path.relative_to(fixture_root)).replace("\\", "/")
        for directory in ("valid", "invalid")
        for path in (fixture_root / directory).glob("*.json")
    )
    assert listed == files


def test_valid_fixtures_do_not_contain_private_reasoning() -> None:
    root = contracts_root()
    for entry in load_manifest()["entries"]:
        if not entry["expectedValid"]:
            continue
        document = json.loads((root / "fixtures" / entry["path"]).read_text(encoding="utf-8"))
        assert not contains_private_reasoning(document), entry["id"]


def test_every_schema_uses_draft_2020_12_and_stable_id() -> None:
    for schema_path in sorted((contracts_root() / "schemas").glob("*.schema.json")):
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        assert schema["$id"] == f"https://schemas.agent-workbench.invalid/contracts/v2/schemas/{schema_path.name}"


def test_contract_consumer_is_not_a_python_service() -> None:
    python_root = Path(__file__).resolve().parents[1]
    assert not (python_root / "app").exists()
    assert not (python_root / "main.py").exists()


def test_agent_event_excludes_queue_stream_and_internal_tool_error() -> None:
    event_schema = json.loads(
        (contracts_root() / "schemas" / "agent-event.schema.json").read_text(encoding="utf-8")
    )
    assert "queue.updated" not in event_schema["properties"]["type"]["enum"]
    unknown_properties = event_schema["$defs"]["ToolUnknownPayload"]["properties"]
    assert "error" not in unknown_properties
    assert "providerStatus" not in unknown_properties
