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
    durable_id = config.DURABLE_AGENT_APP_ID
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
    DAPR_GRPC_PORT: str = "50001"

    # Dapr component names
    PUBSUB_NAME: str = "pubsub"
    STATE_STORE_NAME: str = "workflowstatestore"
    DAPR_SECRETS_STORE: str = "azure-keyvault"

    # Service app IDs for Dapr service invocation
    FUNCTION_ROUTER_APP_ID: str = "function-router"
    DURABLE_AGENT_APP_ID: str = "durable-agent"
    DURABLE_AGENT_ENABLE_NATIVE_CHILD_WORKFLOW: str = "true"
    DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME: str = "durableRunWorkflowV1"
    DURABLE_AGENT_CHILD_WORKFLOW_PLAN_NAME: str = "durablePlanWorkflowV1"
    DURABLE_AGENT_CHILD_WORKFLOW_EXEC_PLAN_NAME: str = "durableRunWorkflowV1"

    # Workflow versioning and runtime controls (Dapr 1.17+)
    DYNAMIC_WORKFLOW_VERSION: str = "v1"
    AP_WORKFLOW_VERSION: str = "v1"
    DYNAMIC_WORKFLOW_CONTINUE_AS_NEW_AFTER_NODES: int = 150
    AP_WORKFLOW_CONTINUE_AS_NEW_AFTER_STEPS: int = 75

    # Runtime feature gate and startup checks
    ENFORCE_MIN_DAPR_VERSION: str = "false"
    MIN_DAPR_RUNTIME_VERSION: str = "1.17.0"

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
            f"FUNCTION_ROUTER_APP_ID={self.FUNCTION_ROUTER_APP_ID}, "
            f"DURABLE_AGENT_APP_ID={self.DURABLE_AGENT_APP_ID}, "
            f"PUBSUB_NAME={self.PUBSUB_NAME}"
        )

    def _load_from_dapr(self) -> dict[str, str]:
        """Try to load configuration from Dapr Configuration store."""
        try:
            from dapr.clients import DaprClient

            keys = [
                "FUNCTION_ROUTER_APP_ID",
                "DURABLE_AGENT_APP_ID",
                "DURABLE_AGENT_ENABLE_NATIVE_CHILD_WORKFLOW",
                "DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME",
                "DURABLE_AGENT_CHILD_WORKFLOW_PLAN_NAME",
                "DURABLE_AGENT_CHILD_WORKFLOW_EXEC_PLAN_NAME",
                "PUBSUB_NAME",
                "STATE_STORE_NAME",
                "DAPR_SECRETS_STORE",
                "DYNAMIC_WORKFLOW_VERSION",
                "AP_WORKFLOW_VERSION",
                "DYNAMIC_WORKFLOW_CONTINUE_AS_NEW_AFTER_NODES",
                "AP_WORKFLOW_CONTINUE_AS_NEW_AFTER_STEPS",
                "ENFORCE_MIN_DAPR_VERSION",
                "MIN_DAPR_RUNTIME_VERSION",
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
            "DAPR_GRPC_PORT": ("DAPR_GRPC_PORT", "50001"),
            "PUBSUB_NAME": ("PUBSUB_NAME", "pubsub"),
            "STATE_STORE_NAME": ("STATE_STORE_NAME", "workflowstatestore"),
            "DAPR_SECRETS_STORE": ("DAPR_SECRETS_STORE", "azure-keyvault"),
            # Note: FUNCTION_RUNNER_APP_ID env var maps to FUNCTION_ROUTER_APP_ID field
            "FUNCTION_ROUTER_APP_ID": ("FUNCTION_RUNNER_APP_ID", "function-router"),
            "DURABLE_AGENT_APP_ID": ("DURABLE_AGENT_APP_ID", "durable-agent"),
            "DURABLE_AGENT_ENABLE_NATIVE_CHILD_WORKFLOW": (
                "DURABLE_AGENT_ENABLE_NATIVE_CHILD_WORKFLOW",
                "true",
            ),
            "DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME": (
                "DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME",
                "durableRunWorkflowV1",
            ),
            "DURABLE_AGENT_CHILD_WORKFLOW_PLAN_NAME": (
                "DURABLE_AGENT_CHILD_WORKFLOW_PLAN_NAME",
                "durablePlanWorkflowV1",
            ),
            "DURABLE_AGENT_CHILD_WORKFLOW_EXEC_PLAN_NAME": (
                "DURABLE_AGENT_CHILD_WORKFLOW_EXEC_PLAN_NAME",
                "durableRunWorkflowV1",
            ),
            "DYNAMIC_WORKFLOW_VERSION": (
                "DYNAMIC_WORKFLOW_VERSION",
                "v1",
            ),
            "AP_WORKFLOW_VERSION": (
                "AP_WORKFLOW_VERSION",
                "v1",
            ),
            "DYNAMIC_WORKFLOW_CONTINUE_AS_NEW_AFTER_NODES": (
                "DYNAMIC_WORKFLOW_CONTINUE_AS_NEW_AFTER_NODES",
                "150",
            ),
            "AP_WORKFLOW_CONTINUE_AS_NEW_AFTER_STEPS": (
                "AP_WORKFLOW_CONTINUE_AS_NEW_AFTER_STEPS",
                "75",
            ),
            "ENFORCE_MIN_DAPR_VERSION": (
                "ENFORCE_MIN_DAPR_VERSION",
                "false",
            ),
            "MIN_DAPR_RUNTIME_VERSION": (
                "MIN_DAPR_RUNTIME_VERSION",
                "1.17.0",
            ),
        }

        for attr, (env_var, default) in field_map.items():
            # Priority: Dapr config > env var > default
            value = dapr_values.get(attr) or os.environ.get(env_var, default)
            if attr in {
                "PORT",
                "DYNAMIC_WORKFLOW_CONTINUE_AS_NEW_AFTER_NODES",
                "AP_WORKFLOW_CONTINUE_AS_NEW_AFTER_STEPS",
            }:
                setattr(self, attr, int(value))
            else:
                setattr(self, attr, value)


# Singleton instance - loaded once at import time
config = OrchestratorConfig()
config.load()
