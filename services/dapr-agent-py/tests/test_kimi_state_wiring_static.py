from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_full_runtime_installs_kimi_reasoning_state_before_config() -> None:
    source = (ROOT / "src/main.py").read_text()

    assert source.index("install_kimi_reasoning_state_schema()") < source.index(
        "state_config = AgentStateConfig("
    )
    assert "message_coercer=coerce_kimi_reasoning_message" in source


def test_minimal_runtime_installs_kimi_reasoning_state_before_config() -> None:
    source = (ROOT / "src/minimal_main.py").read_text()

    assert source.index("install_kimi_reasoning_state_schema()") < source.index(
        "state=AgentStateConfig("
    )
    assert "message_coercer=coerce_kimi_reasoning_message" in source
