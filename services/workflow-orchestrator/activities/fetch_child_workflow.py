"""
Fetch Child Workflow Activity

Fetches a workflow definition from the database for child workflow execution,
with cycle detection to prevent infinite recursion.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import dapr.ext.workflow as wf

logger = logging.getLogger(__name__)


def _get_database_url() -> str:
    """Fetch DATABASE_URL from the Dapr kubernetes-secrets store (cached)."""
    # Reuse the cached helper from app.py at runtime
    from app import _get_database_url as get_db_url
    return get_db_url()


def _fetch_workflow_from_db(workflow_id: str) -> dict[str, Any]:
    """Fetch a workflow definition from the database by ID."""
    from app import _fetch_workflow_from_db as fetch_wf
    return fetch_wf(workflow_id)


def _topological_sort(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Compute execution order for child workflow nodes."""
    from app import _topological_sort as topo_sort
    return topo_sort(nodes, edges)


def _serialize_node(node: dict) -> dict[str, Any]:
    """Flatten React Flow node format to orchestrator SerializedNode format."""
    from app import _serialize_node as serialize
    return serialize(node)


def _lower_while_nodes(
    nodes: list[dict[str, Any]], edges: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Lower while-nodes into loop-until nodes."""
    from app import _lower_while_nodes as lower
    return lower(nodes, edges)


def _build_node_connection_map(nodes: list[dict[str, Any]]) -> dict[str, str]:
    """Build a map of nodeId -> connectionExternalId from node configs."""
    result: dict[str, str] = {}
    for node in nodes:
        node_id = node.get("id")
        if not node_id:
            continue
        data = node.get("data", {}) if isinstance(node.get("data"), dict) else {}
        config = data.get("config", {}) if isinstance(data.get("config"), dict) else {}
        # Check for auth template: {{connections['externalId']}}
        auth = config.get("auth", "")
        if isinstance(auth, str) and "connections['" in auth:
            import re
            match = re.search(r"connections\['([^']+)'\]", auth)
            if match:
                result[node_id] = match.group(1)
    return result


def _scan_for_sub_workflow_ids(nodes: list[dict[str, Any]]) -> list[str]:
    """Extract all workflowId values from sub-workflow nodes in a definition."""
    ids: list[str] = []
    for node in nodes:
        data = node.get("data", {}) if isinstance(node.get("data"), dict) else {}
        node_type = data.get("type") or node.get("type", "")
        if node_type != "sub-workflow":
            continue
        config = data.get("config", {}) if isinstance(data.get("config"), dict) else {}
        wf_id = config.get("workflowId")
        if isinstance(wf_id, str) and wf_id.strip():
            ids.append(wf_id.strip())
    return ids


def fetch_child_workflow(ctx: wf.WorkflowActivityContext, input: dict) -> dict:
    """
    Fetch workflow definition from DB for child workflow execution.

    Performs cycle detection by checking parentWorkflowIds chain.
    Also scans child nodes for nested sub-workflow references to catch
    indirect cycles (A -> B -> A).

    Args:
        input: {
            "workflowId": str,
            "parentWorkflowIds": list[str],
        }

    Returns: {
        "definition": dict,
        "nodeConnectionMap": dict,
        "parentWorkflowIds": list[str],
    }
    """
    workflow_id = input["workflowId"]
    parent_chain = input.get("parentWorkflowIds", [])

    logger.info(
        f"[Fetch Child Workflow] Fetching workflow {workflow_id}, "
        f"parent chain: {parent_chain}"
    )

    # Cycle detection: direct
    if workflow_id in parent_chain:
        raise ValueError(
            f"Cycle detected: workflow {workflow_id} is already in the call chain "
            f"{parent_chain}"
        )

    # Fetch from DB
    wf_data = _fetch_workflow_from_db(workflow_id)
    raw_nodes = wf_data["nodes"]
    raw_edges = wf_data["edges"]

    # Lower while-nodes
    lowered_nodes, lowered_edges = _lower_while_nodes(raw_nodes, raw_edges)

    # Filter out 'add' placeholder nodes
    exec_nodes = [
        n for n in lowered_nodes
        if n.get("type") != "add" and n.get("data", {}).get("type") != "add"
    ]

    # Serialize nodes
    serialized_nodes = [_serialize_node(n) for n in exec_nodes]

    # Filter edges to only reference existing nodes
    node_ids = {n["id"] for n in exec_nodes}
    serialized_edges = [
        {
            "id": e["id"],
            "source": e["source"],
            "target": e["target"],
            "sourceHandle": e.get("sourceHandle"),
            "targetHandle": e.get("targetHandle"),
        }
        for e in lowered_edges
        if e["source"] in node_ids and e["target"] in node_ids
    ]

    # Compute execution order
    execution_order = _topological_sort(
        [{"id": n["id"], "type": n["type"]} for n in serialized_nodes],
        serialized_edges,
    )

    # Build definition
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    definition = {
        "id": wf_data["id"],
        "name": wf_data["name"],
        "version": "1.0.0",
        "nodes": serialized_nodes,
        "edges": serialized_edges,
        "executionOrder": execution_order,
        "createdAt": now,
        "updatedAt": now,
    }

    # Build node connection map
    node_connection_map = _build_node_connection_map(raw_nodes)

    # Extended chain for child
    extended_chain = parent_chain + [workflow_id]

    # Cycle detection: check nested sub-workflow references
    nested_sub_workflow_ids = _scan_for_sub_workflow_ids(raw_nodes)
    for nested_id in nested_sub_workflow_ids:
        if nested_id in extended_chain:
            raise ValueError(
                f"Indirect cycle detected: child workflow {workflow_id} contains "
                f"sub-workflow node referencing {nested_id}, which is already in "
                f"the call chain {extended_chain}"
            )

    logger.info(
        f"[Fetch Child Workflow] Built definition for {wf_data['name']} "
        f"({len(execution_order)} nodes)"
    )

    return {
        "definition": definition,
        "nodeConnectionMap": node_connection_map,
        "parentWorkflowIds": extended_chain,
    }
