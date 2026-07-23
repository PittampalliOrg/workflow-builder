from content_tracing import redact


def test_preview_receiver_coordinates_are_redacted_recursively() -> None:
    assert redact(
        {
            "syncUrl": "http://receiver",
            "nested": {
                "syncCapability": "capability",
                "syncToken": "token",
                "kept": "value",
            },
        }
    ) == {
        "syncUrl": "[REDACTED]",
        "nested": {
            "syncCapability": "[REDACTED]",
            "syncToken": "[REDACTED]",
            "kept": "value",
        },
    }
