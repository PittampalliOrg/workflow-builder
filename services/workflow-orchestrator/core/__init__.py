"""Core types and utilities for the workflow orchestrator."""

from .types import (
    WorkflowNodeType,
    SerializedNode,
    SerializedEdge,
    WorkflowDefinition,
    WorkflowPhase,
    DynamicWorkflowInput,
    DynamicWorkflowOutput,
    WorkflowCustomStatus,
    ActivityExecutionResult,
    ApprovalGateConfig,
    TimerConfig,
)
from .template_resolver import resolve_templates, contains_templates, NodeOutputs

__all__ = [
    "WorkflowNodeType",
    "SerializedNode",
    "SerializedEdge",
    "WorkflowDefinition",
    "WorkflowPhase",
    "DynamicWorkflowInput",
    "DynamicWorkflowOutput",
    "WorkflowCustomStatus",
    "ActivityExecutionResult",
    "ApprovalGateConfig",
    "TimerConfig",
    "resolve_templates",
    "contains_templates",
    "NodeOutputs",
]
