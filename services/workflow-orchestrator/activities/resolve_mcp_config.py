"""Resolve workflow-builder MCP connections for durable agent runs."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any
from urllib.parse import quote

import psycopg2
import requests

try:
    from psycopg2.extras import RealDictCursor
except Exception:  # pragma: no cover - test harness may provide a lightweight stub.
    RealDictCursor = None

from core.config import config

logger = logging.getLogger(__name__)

DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT
SECRET_STORE_NAME = "kubernetes-secrets"
SECRET_NAME = "workflow-builder-secrets"

_database_url: str | None = None
_hosted_mcp_tokens: dict[str, str] = {}


def _get_database_url() -> str:
    global _database_url
    if _database_url is not None:
        return _database_url

    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}"
        f"/v1.0/secrets/{SECRET_STORE_NAME}/{SECRET_NAME}"
    )
    response = requests.get(url, timeout=10)
    response.raise_for_status()
    secrets = response.json()
    db_url = secrets.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError(
            f"DATABASE_URL not found in secret '{SECRET_NAME}' from store '{SECRET_STORE_NAME}'"
        )
    _database_url = db_url
    return db_url


def _normalize_mcp_name(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"^@activepieces/piece-", "", text)
    text = re.sub(r"[^a-z0-9_-]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    if not text:
        text = "mcp_server"
    if not re.match(r"^[a-z_]", text):
        text = f"mcp_{text}"
    return text[:48]


def _json_obj(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _transport_from_metadata(metadata: dict[str, Any]) -> str:
    raw = (
        str(metadata.get("transport") or metadata.get("transportType") or "")
        .strip()
        .lower()
    )
    normalized = raw.replace("-", "_")
    return (
        normalized
        if normalized in {"streamable_http", "sse", "stdio", "websocket"}
        else "streamable_http"
    )


def _allowed_tools_from_metadata(metadata: dict[str, Any]) -> list[str]:
    raw = metadata.get("allowedTools") or metadata.get("allowed_tools")
    if not isinstance(raw, list):
        return []
    return [str(item).strip() for item in raw if str(item).strip()]


def _hosted_mcp_gateway_url(
    project_id: str, metadata: dict[str, Any], fallback_url: str
) -> str:
    endpoint_path = str(
        metadata.get("endpointPath") or "/api/v1/projects/:projectId/mcp-server/http"
    )
    path = endpoint_path.replace(":projectId", quote(project_id, safe=""))
    host = os.environ.get("MCP_GATEWAY_SERVICE_HOST")
    port = os.environ.get("MCP_GATEWAY_SERVICE_PORT_HTTP") or os.environ.get(
        "MCP_GATEWAY_SERVICE_PORT"
    )
    if host and port:
        return f"http://{host}:{port}{path}"
    if fallback_url:
        return fallback_url
    return f"http://mcp-gateway:8080{path}"


def _hosted_mcp_token(project_id: str) -> str:
    if project_id in _hosted_mcp_tokens:
        return _hosted_mcp_tokens[project_id]

    workflow_builder_url = os.environ.get(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")
    internal_token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not internal_token:
        raise RuntimeError("INTERNAL_API_TOKEN is not configured")

    response = requests.get(
        (
            f"{workflow_builder_url}/api/internal/mcp/projects/"
            f"{quote(project_id, safe='')}/server"
        ),
        headers={"X-Internal-Token": internal_token},
        timeout=10,
    )
    response.raise_for_status()
    token = str(response.json().get("token") or "").strip()
    if not token:
        raise RuntimeError(f"Hosted MCP token was empty for project {project_id}")
    _hosted_mcp_tokens[project_id] = token
    return token


def _build_server_config(
    row: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    source_type = str(row.get("source_type") or "")
    display_name = str(row.get("display_name") or "")
    piece_name = row.get("piece_name")
    server_key = row.get("server_key")
    server_url = str(row.get("server_url") or "").strip()
    metadata = _json_obj(row.get("metadata"))

    if source_type == "hosted_workflow":
        project_id = str(row.get("project_id") or "").strip()
        if not project_id:
            return (
                None,
                f"Skipped hosted MCP connection '{display_name}' because it has no project id.",
            )
        try:
            token = _hosted_mcp_token(project_id)
        except Exception as exc:
            return (
                None,
                f"Skipped hosted MCP connection '{display_name}' because its bearer token could not be resolved: {exc}",
            )
        return (
            {
                "server_name": _normalize_mcp_name(
                    f"hosted_{server_key or display_name or row.get('id')}"
                ),
                "displayName": display_name,
                "sourceType": source_type,
                "transport": _transport_from_metadata(metadata),
                "url": _hosted_mcp_gateway_url(project_id, metadata, server_url),
                "headers": {"Authorization": f"Bearer {token}"},
            },
            None,
        )

    if not server_url:
        return None, f"Skipped MCP connection '{display_name}' because it has no server URL."

    if not server_url.startswith(("http://", "https://")):
        return None, f"Skipped MCP connection '{display_name}' because its URL must be HTTP(S)."

    name_basis = piece_name or server_key or display_name or row.get("id")
    server_name = _normalize_mcp_name(name_basis)
    if source_type == "nimble_piece":
        server_name = _normalize_mcp_name(f"piece_{server_name}")
    elif source_type == "nimble_shared":
        server_name = _normalize_mcp_name(f"shared_{server_name}")
    elif source_type == "custom_url":
        server_name = _normalize_mcp_name(f"custom_{server_name}")

    config = {
        "server_name": server_name,
        "displayName": display_name,
        "sourceType": source_type,
        "pieceName": piece_name,
        "connectionExternalId": row.get("connection_external_id"),
        "transport": _transport_from_metadata(metadata),
        "url": server_url,
    }
    allowed_tools = _allowed_tools_from_metadata(metadata)
    if allowed_tools:
        config["allowedTools"] = allowed_tools
    return config, None


def resolve_agent_mcp_servers(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Return sanitized MCP server configs for an agent child workflow."""
    workflow_id = str(input_data.get("workflowId") or "").strip()
    project_id = str(input_data.get("projectId") or "").strip()
    if not workflow_id and not project_id:
        return {"mcpServers": [], "warnings": []}

    warnings: list[str] = []
    servers: list[dict[str, Any]] = []
    seen_names: set[str] = set()

    conn = psycopg2.connect(_get_database_url())
    try:
        cursor_kwargs = {"cursor_factory": RealDictCursor} if RealDictCursor else {}
        with conn.cursor(**cursor_kwargs) as cur:
            if not project_id and workflow_id:
                cur.execute(
                    "select project_id from workflows where id = %s",
                    (workflow_id,),
                )
                workflow_row = cur.fetchone()
                project_id = str((workflow_row or {}).get("project_id") or "").strip()
            project_id = project_id or "default"

            cur.execute(
                """
                select
                  id,
                  source_type,
                  piece_name,
                  server_key,
                  connection_external_id,
                  display_name,
                  registry_ref,
                  server_url,
                  metadata
                from mcp_connection
                where project_id = %s and status = 'ENABLED'
                order by display_name asc
                """,
                (project_id,),
            )
            for row in cur.fetchall():
                config, warning = _build_server_config(dict(row))
                if warning:
                    warnings.append(warning)
                    continue
                if not config:
                    continue
                base_name = config["server_name"]
                server_name = base_name
                suffix = 2
                while server_name in seen_names:
                    server_name = f"{base_name}_{suffix}"
                    suffix += 1
                config["server_name"] = server_name
                seen_names.add(server_name)
                servers.append(config)
    finally:
        conn.close()

    logger.info(
        "[resolve_agent_mcp_servers] workflow=%s project=%s servers=%d warnings=%d",
        workflow_id,
        project_id,
        len(servers),
        len(warnings),
    )
    return {"mcpServers": servers, "warnings": warnings}
