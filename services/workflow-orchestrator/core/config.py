"""
Centralized Configuration Module

Provides a unified interface for accessing configuration values through
Dapr's Configuration building block, with environment variable fallback.

Configuration resolution order:
1. Dapr Configuration store (if available)
2. Environment variables
3. Default values

Usage:
    from core.config import config

    # Access values
    planner_id = config.PLANNER_APP_ID
    dapr_host = config.DAPR_HOST
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Dapr Configuration store component name
CONFIG_STORE_NAME = os.environ.get("DAPR_CONFIG_STORE", "azureappconfig")


@dataclass
class OrchestratorConfig:
    """Centralized configuration for the workflow orchestrator."""

    # Server settings
    PORT: int = 8080
    HOST: str = "0.0.0.0"
    LOG_LEVEL: str = "INFO"

    # Dapr sidecar connection
    DAPR_HOST: str = "localhost"
    DAPR_HTTP_PORT: str = "3500"

    # Dapr component names
    PUBSUB_NAME: str = "pubsub"
    STATE_STORE_NAME: str = "workflowstatestore"
    DAPR_SECRETS_STORE: str = "azure-keyvault"

    # Service app IDs for Dapr service invocation
    FUNCTION_ROUTER_APP_ID: str = "function-router"
    PLANNER_APP_ID: str = "planner-dapr-agent"

    # Tracks whether Dapr Configuration was used
    _loaded_from_dapr: bool = field(default=False, repr=False)

    def load(self) -> None:
        """
        Load configuration from Dapr Configuration store, then env vars.

        Dapr Configuration API is tried first. If unavailable or keys are
        missing, environment variables fill in the gaps.
        """
        dapr_values = self._load_from_dapr()
        self._apply_values(dapr_values)
        logger.info(
            f"[Config] Loaded (dapr={self._loaded_from_dapr}): "
            f"PLANNER_APP_ID={self.PLANNER_APP_ID}, "
            f"FUNCTION_ROUTER_APP_ID={self.FUNCTION_ROUTER_APP_ID}, "
            f"PUBSUB_NAME={self.PUBSUB_NAME}"
        )

    def _load_from_dapr(self) -> dict[str, str]:
        """Try to load configuration from Dapr Configuration store."""
        try:
            from dapr.clients import DaprClient

            keys = [
                "PLANNER_APP_ID",
                "FUNCTION_ROUTER_APP_ID",
                "PUBSUB_NAME",
                "STATE_STORE_NAME",
                "DAPR_SECRETS_STORE",
            ]

            with DaprClient() as client:
                resp = client.get_configuration(
                    store_name=CONFIG_STORE_NAME,
                    keys=keys,
                )

            values: dict[str, str] = {}
            if resp and resp.items:
                for key, item in resp.items.items():
                    if item.value:
                        values[key] = item.value

            if values:
                self._loaded_from_dapr = True
                logger.info(
                    f"[Config] Loaded {len(values)} values from Dapr Configuration store"
                )
            return values

        except Exception as e:
            logger.debug(f"[Config] Dapr Configuration store unavailable: {e}")
            return {}

    def _apply_values(self, dapr_values: dict[str, str]) -> None:
        """Apply values from Dapr config, then fill gaps from env vars."""
        # Map of config field -> (env var name, default)
        field_map: dict[str, tuple[str, str]] = {
            "PORT": ("PORT", "8080"),
            "HOST": ("HOST", "0.0.0.0"),
            "LOG_LEVEL": ("LOG_LEVEL", "INFO"),
            "DAPR_HOST": ("DAPR_HOST", "localhost"),
            "DAPR_HTTP_PORT": ("DAPR_HTTP_PORT", "3500"),
            "PUBSUB_NAME": ("PUBSUB_NAME", "pubsub"),
            "STATE_STORE_NAME": ("STATE_STORE_NAME", "workflowstatestore"),
            "DAPR_SECRETS_STORE": ("DAPR_SECRETS_STORE", "azure-keyvault"),
            # Note: FUNCTION_RUNNER_APP_ID env var maps to FUNCTION_ROUTER_APP_ID field
            "FUNCTION_ROUTER_APP_ID": ("FUNCTION_RUNNER_APP_ID", "function-router"),
            "PLANNER_APP_ID": ("PLANNER_APP_ID", "planner-dapr-agent"),
        }

        for attr, (env_var, default) in field_map.items():
            # Priority: Dapr config > env var > default
            value = dapr_values.get(attr) or os.environ.get(env_var, default)
            if attr == "PORT":
                setattr(self, attr, int(value))
            else:
                setattr(self, attr, value)


# Singleton instance - loaded once at import time
config = OrchestratorConfig()
config.load()
