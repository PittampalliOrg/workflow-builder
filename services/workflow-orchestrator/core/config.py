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
    agent_id = config.DAPR_AGENT_PY_APP_ID
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
    TASKHUB_RPC_TIMEOUT_SECONDS: float = 15.0

    # Dapr component names
    PUBSUB_NAME: str = "pubsub"
    STATE_STORE_NAME: str = "workflowstatestore"
    DAPR_SECRETS_STORE: str = "azure-keyvault"

    # Service app IDs for Dapr service invocation
    FUNCTION_ROUTER_APP_ID: str = "function-router"
    WORKSPACE_RUNTIME_APP_ID: str = "workspace-runtime"
    DAPR_AGENT_PY_APP_ID: str = "dapr-agent-py"
    DAPR_AGENT_PY_TESTING_APP_ID: str = "dapr-agent-py-testing"
    ADK_AGENT_PY_APP_ID: str = "adk-agent-py"
    CLAUDE_AGENT_PY_APP_ID: str = "claude-agent-py"
    # interactive-cli family (cli-agent-py host service; per-session sandbox pods).
    # All three CLI runtimes share ONE host image/service — distinct config keys
    # exist only because the runtime registry reader getattrs each appIdConfigKey.
    CLAUDE_CODE_CLI_APP_ID: str = "cli-agent-py"
    CODEX_CLI_APP_ID: str = "cli-agent-py"
    AGY_CLI_APP_ID: str = "cli-agent-py"
    BROWSER_USE_AGENT_APP_ID: str = "browser-use-agent"
    CLAUDE_CODE_AGENT_APP_ID: str = "claude-code-agent"
    OPENSHELL_AGENT_APP_ID: str = "openshell-agent-runtime.openshell"
    DURABLE_AGENT_ENABLE_NATIVE_CHILD_WORKFLOW: str = "true"
    # dapr-agent-py DurableAgent registers @workflow_entry under the Python
    # function name (agent_workflow) via register_workflow with no alternate
    # name override.
    DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME: str = "agent_workflow"
    CLAUDE_CODE_AGENT_CHILD_WORKFLOW_RUN_NAME: str = "claudeCodeRunWorkflowV1"
    DURABLE_AGENT_CHILD_WORKFLOW_PLAN_NAME: str = "agent_workflow"
    DURABLE_AGENT_CHILD_WORKFLOW_EXEC_PLAN_NAME: str = "agent_workflow"

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
            f"WORKSPACE_RUNTIME_APP_ID={self.WORKSPACE_RUNTIME_APP_ID}, "
            f"DAPR_AGENT_PY_APP_ID={self.DAPR_AGENT_PY_APP_ID}, "
            f"PUBSUB_NAME={self.PUBSUB_NAME}"
        )

    def _load_from_dapr(self) -> dict[str, str]:
        """Try to load configuration from Dapr Configuration store."""
        try:
            from dapr.clients import DaprClient

            keys = [
                "FUNCTION_ROUTER_APP_ID",
                "WORKSPACE_RUNTIME_APP_ID",
                "DAPR_AGENT_PY_APP_ID",
                "DAPR_AGENT_PY_TESTING_APP_ID",
                "ADK_AGENT_PY_APP_ID",
                "CLAUDE_AGENT_PY_APP_ID",
                "CLAUDE_CODE_CLI_APP_ID",
                "CODEX_CLI_APP_ID",
                "AGY_CLI_APP_ID",
                "CLAUDE_CODE_AGENT_APP_ID",
                "OPENSHELL_AGENT_APP_ID",
                "DURABLE_AGENT_ENABLE_NATIVE_CHILD_WORKFLOW",
                "DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME",
                "CLAUDE_CODE_AGENT_CHILD_WORKFLOW_RUN_NAME",
                "DURABLE_AGENT_CHILD_WORKFLOW_PLAN_NAME",
                "DURABLE_AGENT_CHILD_WORKFLOW_EXEC_PLAN_NAME",
                "PUBSUB_NAME",
                "STATE_STORE_NAME",
                "DAPR_SECRETS_STORE",
                "TASKHUB_RPC_TIMEOUT_SECONDS",
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
            "TASKHUB_RPC_TIMEOUT_SECONDS": ("TASKHUB_RPC_TIMEOUT_SECONDS", "15"),
            "PUBSUB_NAME": ("PUBSUB_NAME", "pubsub"),
            "STATE_STORE_NAME": ("STATE_STORE_NAME", "workflowstatestore"),
            "DAPR_SECRETS_STORE": ("DAPR_SECRETS_STORE", "azure-keyvault"),
            # Note: FUNCTION_RUNNER_APP_ID env var maps to FUNCTION_ROUTER_APP_ID field
            "FUNCTION_ROUTER_APP_ID": ("FUNCTION_RUNNER_APP_ID", "function-router"),
            "WORKSPACE_RUNTIME_APP_ID": (
                "WORKSPACE_RUNTIME_APP_ID",
                "workspace-runtime",
            ),
            "DAPR_AGENT_PY_APP_ID": ("DAPR_AGENT_PY_APP_ID", "dapr-agent-py"),
            "DAPR_AGENT_PY_TESTING_APP_ID": (
                "DAPR_AGENT_PY_TESTING_APP_ID",
                "dapr-agent-py-testing",
            ),
            "ADK_AGENT_PY_APP_ID": ("ADK_AGENT_PY_APP_ID", "adk-agent-py"),
            "CLAUDE_AGENT_PY_APP_ID": (
                "CLAUDE_AGENT_PY_APP_ID",
                "claude-agent-py",
            ),
            "CLAUDE_CODE_CLI_APP_ID": (
                "CLAUDE_CODE_CLI_APP_ID",
                "cli-agent-py",
            ),
            "CODEX_CLI_APP_ID": ("CODEX_CLI_APP_ID", "cli-agent-py"),
            "AGY_CLI_APP_ID": ("AGY_CLI_APP_ID", "cli-agent-py"),
            "BROWSER_USE_AGENT_APP_ID": ("BROWSER_USE_AGENT_APP_ID", "browser-use-agent"),
            "CLAUDE_CODE_AGENT_APP_ID": (
                "CLAUDE_CODE_AGENT_APP_ID",
                "claude-code-agent",
            ),
            "OPENSHELL_AGENT_APP_ID": (
                "OPENSHELL_AGENT_APP_ID",
                "openshell-agent-runtime.openshell",
            ),
            "DURABLE_AGENT_ENABLE_NATIVE_CHILD_WORKFLOW": (
                "DURABLE_AGENT_ENABLE_NATIVE_CHILD_WORKFLOW",
                "true",
            ),
            "DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME": (
                "DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME",
                "agent_workflow",
            ),
            "CLAUDE_CODE_AGENT_CHILD_WORKFLOW_RUN_NAME": (
                "CLAUDE_CODE_AGENT_CHILD_WORKFLOW_RUN_NAME",
                "claudeCodeRunWorkflowV1",
            ),
            "DURABLE_AGENT_CHILD_WORKFLOW_PLAN_NAME": (
                "DURABLE_AGENT_CHILD_WORKFLOW_PLAN_NAME",
                "agent_workflow",
            ),
            "DURABLE_AGENT_CHILD_WORKFLOW_EXEC_PLAN_NAME": (
                "DURABLE_AGENT_CHILD_WORKFLOW_EXEC_PLAN_NAME",
                "agent_workflow",
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
            }:
                setattr(self, attr, int(value))
            elif attr == "TASKHUB_RPC_TIMEOUT_SECONDS":
                setattr(self, attr, float(value))
            else:
                setattr(self, attr, value)


# Singleton instance - loaded once at import time
config = OrchestratorConfig()
config.load()
