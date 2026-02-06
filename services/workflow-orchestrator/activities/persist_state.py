"""
Persist State Activity

Saves workflow state and outputs to Dapr state store.
Used for checkpointing and storing intermediate results.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from dapr.clients import DaprClient

from core.config import config

logger = logging.getLogger(__name__)

STATE_STORE_NAME = config.STATE_STORE_NAME


def persist_state(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Save state to Dapr state store.

    Args:
        ctx: Dapr workflow context (not used but required by Dapr)
        input_data: Dict with keys: key, value, metadata (optional)

    Returns:
        Dict with success status and key
    """
    key = input_data.get("key", "")
    value = input_data.get("value")
    metadata = input_data.get("metadata")

    logger.info(f"[Persist State] Saving state with key: {key}")

    try:
        # Dapr state store requires string values - JSON-serialize dicts/lists
        if not isinstance(value, str):
            value = json.dumps(value)

        with DaprClient() as client:
            client.save_state(
                store_name=STATE_STORE_NAME,
                key=key,
                value=value,
                state_metadata=metadata,
            )

        logger.info(f"[Persist State] Successfully saved state: {key}")

        return {
            "success": True,
            "key": key,
        }

    except Exception as e:
        error_msg = str(e)
        logger.error(f"[Persist State] Failed to save state {key}: {e}")

        return {
            "success": False,
            "key": key,
            "error": f"Failed to persist state: {error_msg}",
        }


def get_state(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Get state from Dapr state store.

    Args:
        ctx: Dapr workflow context (not used but required by Dapr)
        input_data: Dict with key

    Returns:
        Dict with success status, key, and value
    """
    key = input_data.get("key", "")

    logger.info(f"[Get State] Retrieving state with key: {key}")

    try:
        with DaprClient() as client:
            result = client.get_state(store_name=STATE_STORE_NAME, key=key)

        logger.info(f"[Get State] Successfully retrieved state: {key}")

        return {
            "success": True,
            "key": key,
            "value": result.data if result.data else None,
        }

    except Exception as e:
        error_msg = str(e)
        logger.error(f"[Get State] Failed to get state {key}: {e}")

        return {
            "success": False,
            "key": key,
            "error": f"Failed to get state: {error_msg}",
        }


def delete_state(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Delete state from Dapr state store.

    Args:
        ctx: Dapr workflow context (not used but required by Dapr)
        input_data: Dict with key

    Returns:
        Dict with success status and key
    """
    key = input_data.get("key", "")

    logger.info(f"[Delete State] Deleting state with key: {key}")

    try:
        with DaprClient() as client:
            client.delete_state(store_name=STATE_STORE_NAME, key=key)

        logger.info(f"[Delete State] Successfully deleted state: {key}")

        return {
            "success": True,
            "key": key,
        }

    except Exception as e:
        error_msg = str(e)
        logger.error(f"[Delete State] Failed to delete state {key}: {e}")

        return {
            "success": False,
            "key": key,
            "error": f"Failed to delete state: {error_msg}",
        }
