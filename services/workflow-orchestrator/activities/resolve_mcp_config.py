"""Resolve workflow-builder MCP connections for durable agent runs."""

from __future__ import annotations

import logging
import os
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from activities.workflow_data_client import workflow_data_client

logger = logging.getLogger(__name__)


def _allowed_tools_from_request(server: dict[str, Any]) -> list[str]:
    raw = server.get("allowedTools") or server.get("allowed_tools")
    if not isinstance(raw, list):
        return []
    return [str(item).strip() for item in raw if str(item).strip()]


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

    api_result = _resolve_agent_mcp_servers_via_workflow_data_api(
        input_data,
        requested_servers,
        include_project_connections,
    )
    logger.info(
        "[resolve_agent_mcp_servers] resolved via workflow-data API workflow=%s project=%s servers=%d warnings=%d",
        workflow_id,
        project_id,
        len(api_result.get("mcpServers") or []),
        len(api_result.get("warnings") or []),
    )
    return api_result
