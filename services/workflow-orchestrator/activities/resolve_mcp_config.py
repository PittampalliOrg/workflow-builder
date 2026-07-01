"""Resolve workflow-builder MCP connections for durable agent runs."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

import psycopg2
import requests

try:
    from psycopg2.extras import RealDictCursor
except Exception:  # pragma: no cover - test harness may provide a lightweight stub.
    RealDictCursor = None

from core.config import config
from activities.workflow_data_client import workflow_data_api_mode, workflow_data_client

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


def _allowed_tools_from_request(server: dict[str, Any]) -> list[str]:
    raw = server.get("allowedTools") or server.get("allowed_tools")
    if not isinstance(raw, list):
        return []
    return [str(item).strip() for item in raw if str(item).strip()]


def _tool_selection_from_metadata(metadata: dict[str, Any]) -> list[str] | None:
    """Project ceiling set by the Integrations UI at
    ``mcp_connection.metadata.toolSelection = {tools: [...]}``. ``None`` = no
    selection stored (all tools). Mirrors the BFF ``toolAllowlistFromMetadata``.
    """
    selection = metadata.get("toolSelection")
    if not isinstance(selection, dict):
        return None
    tools = selection.get("tools")
    if not isinstance(tools, list):
        return None
    seen: list[str] = []
    for item in tools:
        value = str(item or "").strip()
        if value and value not in seen:
            seen.append(value)
    return seen


def _parse_tools_query_param(url: str | None) -> list[str] | None:
    """Read the ``?tools=a,b`` allowlist already on a piece URL. ``None`` when
    absent (= ceiling unbounded). Mirrors the BFF ``parseToolsQueryParam``."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except Exception:
        return None
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if key == "tools":
            seen: list[str] = []
            for item in value.split(","):
                tool = item.strip()
                if tool and tool not in seen:
                    seen.append(tool)
            return seen
    return None


def _append_tools_query_param(url: str, allowlist: list[str] | None) -> str:
    """Carry a tool allowlist on a piece URL as ``?tools=a,b``. ``None`` = no
    restriction (param omitted). Mirrors the BFF ``appendToolsQueryParam``."""
    if allowlist is None:
        return url
    try:
        parsed = urlparse(url)
    except Exception:
        return url
    params = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k != "tools"]
    params.append(("tools", ",".join(allowlist)))
    return urlunparse(parsed._replace(query=urlencode(params)))


def _narrow_tools_to_intersection(
    url: str, agent_allowed_tools: list[str] | None
) -> tuple[str, list[str] | None]:
    """Narrow a piece URL's ``?tools=`` to ceiling ∩ per-agent allowlist. An
    agent only narrows within the workspace ceiling, never widens. Empty/None
    agent list = no agent narrowing (keep the ceiling). Mirrors the BFF
    ``narrowToolsToIntersection``."""
    agent = [t for t in (agent_allowed_tools or []) if str(t or "").strip()]
    if not agent:
        return url, _parse_tools_query_param(url)
    ceiling = _parse_tools_query_param(url)
    effective = agent if ceiling is None else [t for t in agent if t in ceiling]
    return _append_tools_query_param(url, effective), effective


def _server_identity_values(server: dict[str, Any]) -> set[str]:
    values: set[str] = set()
    for key in (
        "server_name",
        "serverName",
        "name",
        "pieceName",
        "serverKey",
        "displayName",
    ):
        value = str(server.get(key) or "").strip()
        if value:
            values.add(value.lower())
            values.add(_normalize_mcp_name(value))
    piece_name = str(server.get("pieceName") or "").strip()
    if piece_name:
        values.add(_normalize_mcp_name(f"piece_{piece_name}"))
    server_key = str(server.get("serverKey") or "").strip()
    if server_key:
        values.add(_normalize_mcp_name(f"custom_{server_key}"))
        values.add(_normalize_mcp_name(f"shared_{server_key}"))
    return values


def _request_has_direct_endpoint(server: dict[str, Any]) -> bool:
    return bool(
        str(server.get("url") or server.get("serverUrl") or "").strip()
        or str(server.get("command") or "").strip()
    )


def _is_short_k8s_host(hostname: str) -> bool:
    if not hostname or "." in hostname:
        return False
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return False
    return bool(re.match(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", hostname))


def _should_qualify_server_url(server: dict[str, Any]) -> bool:
    source_type = str(server.get("sourceType") or server.get("source_type") or "")
    if source_type in {"nimble_piece", "nimble_shared", "hosted_workflow"}:
        return True
    registry_ref = str(server.get("registryRef") or server.get("registry_ref") or "")
    return registry_ref.startswith(("ap-", "nimble-", "shared-")) or registry_ref in {
        "mcp-gateway",
        "shared-workflow-mcp-server",
    }


def _is_activepieces_piece_service_host(hostname: str) -> bool:
    service_name = hostname.split(".", 1)[0]
    return bool(re.match(r"^ap-[a-z0-9]([-a-z0-9]*[a-z0-9])?-service$", service_name))


def _should_use_knative_piece_service_url(server: dict[str, Any]) -> bool:
    source_type = str(server.get("sourceType") or server.get("source_type") or "")
    registry_ref = str(server.get("registryRef") or server.get("registry_ref") or "")
    return source_type == "nimble_piece" or registry_ref.startswith("ap-")


def _normalize_legacy_piece_mcp_port(server: dict[str, Any], url: str) -> str:
    text = str(url or "").strip()
    if not text or not _should_use_knative_piece_service_url(server):
        return text
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return text
    if _is_activepieces_piece_service_host(parsed.hostname) and parsed.port == 3100:
        return urlunparse(parsed._replace(netloc=parsed.hostname))
    return text


def _qualify_mcp_server_url(server: dict[str, Any], url: str) -> str:
    text = _normalize_legacy_piece_mcp_port(server, str(url or ""))
    if not text or not _should_qualify_server_url(server):
        return text
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return text
    if not _is_short_k8s_host(parsed.hostname):
        return text

    namespace = str(
        server.get("namespace")
        or os.environ.get("MCP_CONNECTION_NAMESPACE")
        or os.environ.get("WORKFLOW_BUILDER_NAMESPACE")
        or "workflow-builder"
    ).strip()
    qualified_host = f"{parsed.hostname}.{namespace}.svc.cluster.local"
    if parsed.port:
        qualified_host = f"{qualified_host}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=qualified_host))


def _sanitize_requested_server(server: dict[str, Any]) -> dict[str, Any]:
    sanitized = dict(server)
    if sanitized.get("serverUrl") and not sanitized.get("url"):
        sanitized["url"] = sanitized["serverUrl"]
    if sanitized.get("url"):
        sanitized["url"] = _qualify_mcp_server_url(sanitized, str(sanitized["url"]))
    if sanitized.get("serverUrl"):
        sanitized["serverUrl"] = _qualify_mcp_server_url(
            sanitized, str(sanitized["serverUrl"])
        )
    allowed_tools = _allowed_tools_from_request(server)
    if allowed_tools:
        sanitized["allowedTools"] = allowed_tools
        if sanitized.get("sourceType") == "nimble_piece" and sanitized.get("url"):
            url, effective = _narrow_tools_to_intersection(
                str(sanitized["url"]), allowed_tools
            )
            sanitized["url"] = url
            if effective is not None:
                sanitized["allowedTools"] = effective
    return sanitized


def _merge_requested_over_resolved(
    resolved: dict[str, Any], requested: dict[str, Any]
) -> dict[str, Any]:
    merged = {**resolved}
    for key in ("displayName", "sourceType", "pieceName", "serverKey"):
        if requested.get(key):
            merged[key] = requested[key]
    allowed_tools = _allowed_tools_from_request(requested)
    if allowed_tools:
        merged["allowedTools"] = allowed_tools
        # resolved["url"] already carries the project ceiling as `?tools=`
        # (set in _build_server_config). Re-narrow it to ceiling ∩ per-agent
        # allowedTools so the piece-mcp-server enforces the agent's narrowing
        # at the transport, matching the BFF resolver.
        if merged.get("sourceType") == "nimble_piece" and merged.get("url"):
            url, effective = _narrow_tools_to_intersection(
                str(merged["url"]), allowed_tools
            )
            merged["url"] = url
            if effective is not None:
                merged["allowedTools"] = effective
    return merged


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
    connection_external_id = str(row.get("connection_external_id") or "").strip()
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
        "connectionExternalId": connection_external_id or None,
        "transport": _transport_from_metadata(metadata),
        "url": _qualify_mcp_server_url(
            {
                "sourceType": source_type,
                "registryRef": row.get("registry_ref"),
            },
            server_url,
        ),
    }
    if connection_external_id:
        config["headers"] = {"X-Connection-External-Id": connection_external_id}
    allowed_tools = _allowed_tools_from_metadata(metadata)
    if allowed_tools:
        config["allowedTools"] = allowed_tools

    # Project ceiling (Integrations UI -> metadata.toolSelection.tools): carry it
    # in the piece URL as `?tools=` so piece-mcp-server enforces it at tool
    # registration on the durable/run path too (previously this path had ZERO
    # transport tool enforcement). null = no selection = all tools.
    tool_selection = _tool_selection_from_metadata(metadata)
    if tool_selection is not None and source_type == "nimble_piece" and config.get("url"):
        config["url"] = _append_tools_query_param(str(config["url"]), tool_selection)
        if not config.get("allowedTools") and tool_selection:
            config["allowedTools"] = tool_selection
    return config, None


def _resolve_agent_mcp_servers_via_workflow_data_api(
    input_data: dict[str, Any],
    requested_servers: list[dict[str, Any]],
    include_project_connections: bool,
) -> dict[str, Any] | None:
    payload = workflow_data_client.resolve_mcp_config(
        {
            "workflowId": str(input_data.get("workflowId") or "").strip() or None,
            "projectId": str(input_data.get("projectId") or "").strip() or None,
            "requestedServers": requested_servers,
            "includeProjectConnections": include_project_connections,
        }
    )
    if not isinstance(payload, dict) or not isinstance(payload.get("mcpServers"), list):
        raise RuntimeError("workflow-data MCP response did not include mcpServers[]")
    warnings = payload.get("warnings") if isinstance(payload.get("warnings"), list) else []
    return {
        "mcpServers": payload["mcpServers"],
        "warnings": [str(item) for item in warnings],
    }


def resolve_agent_mcp_servers(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Return sanitized MCP server configs for an agent child workflow."""
    workflow_id = str(input_data.get("workflowId") or "").strip()
    project_id = str(input_data.get("projectId") or "").strip()
    requested_servers = [
        item
        for item in (
            input_data.get("requestedServers")
            if isinstance(input_data.get("requestedServers"), list)
            else []
        )
        if isinstance(item, dict)
    ]
    include_project_connections = bool(input_data.get("includeProjectConnections"))
    if not workflow_id and not project_id:
        direct_servers = [
            _sanitize_requested_server(item)
            for item in requested_servers
            if _request_has_direct_endpoint(item)
        ]
        return {"mcpServers": direct_servers, "warnings": []}

    api_mode = workflow_data_api_mode()
    if api_mode != "postgres":
        try:
            api_result = _resolve_agent_mcp_servers_via_workflow_data_api(
                input_data,
                requested_servers,
                include_project_connections,
            )
            if api_result is not None:
                logger.info(
                    "[resolve_agent_mcp_servers] resolved via workflow-data API workflow=%s project=%s servers=%d warnings=%d",
                    workflow_id,
                    project_id,
                    len(api_result.get("mcpServers") or []),
                    len(api_result.get("warnings") or []),
                )
                return api_result
        except Exception as exc:
            if api_mode == "http":
                raise
            logger.warning(
                "workflow-data MCP resolve failed; falling back to direct Postgres path: %s",
                exc,
            )

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
                  project_id,
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
            connection_configs: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for row in cur.fetchall():
                config, warning = _build_server_config(dict(row))
                if warning:
                    warnings.append(warning)
                    continue
                if not config:
                    continue
                connection_configs.append((config, dict(row)))

            for requested in requested_servers:
                if _request_has_direct_endpoint(requested):
                    config = _sanitize_requested_server(requested)
                else:
                    request_identities = _server_identity_values(requested)
                    match = next(
                        (
                            config
                            for config, row in connection_configs
                            if request_identities
                            & (
                                _server_identity_values(config)
                                | _server_identity_values(
                                    {
                                        "pieceName": row.get("piece_name"),
                                        "serverKey": row.get("server_key"),
                                        "displayName": row.get("display_name"),
                                        "sourceType": row.get("source_type"),
                                    }
                                )
                            )
                        ),
                        None,
                    )
                    if not match:
                        warnings.append(
                            "Skipped MCP profile server "
                            f"'{requested.get('displayName') or requested.get('server_name') or requested.get('pieceName') or 'unknown'}' "
                            "because no enabled project MCP connection matched it."
                        )
                        continue
                    config = _merge_requested_over_resolved(match, requested)

                base_name = config["server_name"]
                server_name = base_name
                suffix = 2
                while server_name in seen_names:
                    server_name = f"{base_name}_{suffix}"
                    suffix += 1
                config["server_name"] = server_name
                seen_names.add(server_name)
                servers.append(config)

            if include_project_connections:
                for config, _row in connection_configs:
                    key = str(config.get("server_name") or "").strip()
                    if key and key in seen_names:
                        continue
                    if key:
                        seen_names.add(key)
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
