from types import MappingProxyType
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.telemetry.providers import (
    _install_otlp_attribute_encoder_guard,
    _SanitizingSpanProcessor,
    _attrs_with_valid_span_type,
)


class DummySpan:
    def __init__(self, name: str, attrs: dict):
        self.name = name
        self._attributes = attrs

    @property
    def attributes(self):
        return MappingProxyType(self._attributes)


def test_sanitizer_replaces_null_span_type_on_start():
    span = DummySpan(
        "LLM.generate_content",
        {"span_type": None, "mlflow.spanType": None, "kept": "value"},
    )

    _SanitizingSpanProcessor().on_start(span)

    assert span.attributes["span_type"] == "CHAT_MODEL"
    assert span.attributes["mlflow.spanType"] == "CHAT_MODEL"
    assert span.attributes["kept"] == "value"


def test_sanitizer_uses_chain_for_unknown_null_span_type():
    attrs = _attrs_with_valid_span_type(
        DummySpan("unknown.operation", {"span_type": None}),
        {"span_type": None, "other": None},
    )

    assert attrs == {
        "span_type": "CHAIN",
        "mlflow.spanType": "CHAIN",
    }


def test_otlp_encoder_guard_filters_null_attributes():
    trace_encoder = pytest.importorskip(
        "opentelemetry.exporter.otlp.proto.common._internal.trace_encoder"
    )

    _install_otlp_attribute_encoder_guard()

    encoded = trace_encoder._encode_attributes(
        {"span_type": None, "mlflow.spanType": "TOOL", "other": None}
    )

    assert [item.key for item in encoded] == ["mlflow.spanType"]
