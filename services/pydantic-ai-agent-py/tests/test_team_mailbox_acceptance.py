from pathlib import Path


def test_raise_endpoint_returns_exact_team_mailbox_acceptance_receipt() -> None:
    source = (Path(__file__).parents[1] / "src" / "main.py").read_text()
    endpoint = source[source.index("def raise_session_event_endpoint") :]

    assert 'delivery.get("kind") == "team-mailbox"' in endpoint
    assert "len(event_ids) != len(events)" in endpoint
    assert '"accepted": True' in endpoint
    assert '"deliveryId": delivery_id' in endpoint
    assert endpoint.index(
        '_taskhub_call("RaiseEvent", raise_request)'
    ) < endpoint.index('"accepted": True')
