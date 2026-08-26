from __future__ import annotations

from pathlib import Path

from backend.assistant_tools import AssistantToolService
from backend.help_assistant.scope import build_tool_scope
from backend.settings import Settings

from .test_designer import project_with_button


def assistant_settings(tmp_path: Path) -> Settings:
    return Settings(
        access_level="write",
        max_file_size=1024 * 1024,
        protect_sensitive_paths=True,
        config_root=tmp_path / "esphome",
        data_root=tmp_path / "data",
        mcp_mode="lan",
        mcp_access="project_write",
        mcp_access_token="test-token-" + "x" * 32,
        assistant_mode="enabled",
        assistant_api_key="sk-test-" + "x" * 32,
    )


def test_scope_never_exposes_a_project_or_configuration_name_parameter(
    tmp_path: Path,
) -> None:
    """The model must have no parameter through which it could choose a
    different project/configuration - the whole point of hard-binding the
    session is that there is nothing to redirect, not that a value is
    checked after the fact."""
    settings = assistant_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    (settings.config_root / "panel.yaml").write_text(
        "esphome:\n  name: panel\n", encoding="utf-8"
    )
    service = AssistantToolService(settings)
    service.projects.save("display.lvgldesign", project_with_button(), None)

    tools = build_tool_scope(
        service,
        project_name="display.lvgldesign",
        configuration_name="panel.yaml",
        identity="assistant:test-user",
    )

    forbidden_keys = {"name", "project_name", "configuration_name"}
    for tool in tools:
        properties = set(tool.input_schema.get("properties", {}))
        assert not (properties & forbidden_keys), (
            f"{tool.name} exposes a project/configuration selector: {properties}"
        )


def test_scope_tools_are_hard_bound_regardless_of_injected_arguments(
    tmp_path: Path,
) -> None:
    """Even if a handler were called with attacker-supplied extra keys (e.g.
    from a compromised model ignoring the schema), the bound project/
    configuration name must still be the one used - args can never override it."""
    settings = assistant_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    (settings.config_root / "panel.yaml").write_text(
        "esphome:\n  name: panel\n", encoding="utf-8"
    )
    (settings.config_root / "other.yaml").write_text(
        "esphome:\n  name: other\n", encoding="utf-8"
    )
    service = AssistantToolService(settings)
    service.projects.save("display.lvgldesign", project_with_button(), None)
    service.projects.save("other.lvgldesign", project_with_button(), None)

    tools = {
        tool.name: tool
        for tool in build_tool_scope(
            service,
            project_name="display.lvgldesign",
            configuration_name="panel.yaml",
            identity="assistant:test-user",
        )
    }

    injected = {
        "name": "other.lvgldesign",
        "project_name": "other.lvgldesign",
        "configuration_name": "other.yaml",
    }
    result = tools["read_project"].handler({**injected, "view": "summary"})
    assert result["ok"] is True
    assert result["name"] == "display.lvgldesign"

    config_result = tools["read_configuration"].handler(injected)
    assert config_result["ok"] is True
    assert config_result["name"] == "panel.yaml"


def test_scope_omits_read_configuration_when_none_is_bound(tmp_path: Path) -> None:
    settings = assistant_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    service = AssistantToolService(settings)
    service.projects.save("display.lvgldesign", project_with_button(), None)

    tools = build_tool_scope(
        service,
        project_name="display.lvgldesign",
        configuration_name=None,
        identity="assistant:test-user",
    )

    assert "read_configuration" not in {tool.name for tool in tools}


def test_scope_never_exposes_apply_build_or_install_tools(tmp_path: Path) -> None:
    """The restricted catalog is exhaustive: nothing beyond read/validate/
    binding-targets/catalog/two propose tools, ever."""
    settings = assistant_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    service = AssistantToolService(settings)
    service.projects.save("display.lvgldesign", project_with_button(), None)

    tools = build_tool_scope(
        service,
        project_name="display.lvgldesign",
        configuration_name="panel.yaml",
        identity="assistant:test-user",
    )

    assert {tool.name for tool in tools} == {
        "read_project",
        "validate_project",
        "binding_targets",
        "widget_catalog",
        "propose_layout_change",
        "propose_binding_change",
        "read_configuration",
    }


def test_scope_propose_layout_change_creates_a_real_changeset_not_applied(
    tmp_path: Path,
) -> None:
    settings = assistant_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    service = AssistantToolService(settings)
    created = service.projects.save("display.lvgldesign", project_with_button(), None)

    tools = {
        tool.name: tool
        for tool in build_tool_scope(
            service,
            project_name="display.lvgldesign",
            configuration_name=None,
            identity="assistant:test-user",
        )
    }

    result = tools["propose_layout_change"].handler(
        {
            "base_revision": created["revision"],
            "operations": [
                {
                    "op": "add_widget",
                    "widget_id": "assistant_label",
                    "widget_type": "label",
                    "placement": {"x": 10, "y": 10},
                    "properties": {"text": "From assistant"},
                }
            ],
        }
    )

    assert result["ok"] is True
    assert result["status"] == "pending"
    # Proposing never touches the stored project - only an explicit apply
    # (never called by the model in this scope) would.
    assert service.projects.read("display.lvgldesign")["revision"] == created["revision"]
    assert "assistant:test-user" in [
        entry["user_id"] for entry in service.audit.recent()
    ]


def test_scope_handler_converts_api_errors_instead_of_raising(tmp_path: Path) -> None:
    settings = assistant_settings(tmp_path)
    settings.config_root.mkdir(parents=True)
    service = AssistantToolService(settings)

    tools = {
        tool.name: tool
        for tool in build_tool_scope(
            service,
            project_name="does-not-exist.lvgldesign",
            configuration_name=None,
            identity="assistant:test-user",
        )
    }

    result = tools["read_project"].handler({})
    assert result["ok"] is False
    assert result["error"] == "project_not_found"


def test_scope_cannot_read_secrets_yaml_even_if_bound_as_configuration(
    tmp_path: Path,
) -> None:
    """Defense in depth: even though the router only lets an administrator
    type an arbitrary configuration_name, the same unconditional MCP-layer
    secrets guard still applies here since this goes through the identical
    AssistantToolService.read_configuration call."""
    import dataclasses

    settings = dataclasses.replace(
        assistant_settings(tmp_path), protect_sensitive_paths=False
    )
    settings.config_root.mkdir(parents=True)
    (settings.config_root / "secrets.yaml").write_text(
        "wifi_password: hunter2\n", encoding="utf-8"
    )
    service = AssistantToolService(settings)
    service.projects.save("display.lvgldesign", project_with_button(), None)

    tools = {
        tool.name: tool
        for tool in build_tool_scope(
            service,
            project_name="display.lvgldesign",
            configuration_name="secrets.yaml",
            identity="assistant:test-user",
        )
    }

    result = tools["read_configuration"].handler({})
    assert result["ok"] is False
    assert result["error"] == "secrets_file_protected"
