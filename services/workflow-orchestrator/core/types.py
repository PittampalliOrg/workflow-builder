"""
Core Types for Workflow Orchestrator

These types define the data structures used by the orchestrator
for workflow execution, status tracking, and inter-service communication.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class WorkflowNodeType(str, Enum):
    """Node types supported by the workflow engine."""
    TRIGGER = "trigger"
    ACTION = "action"
    CONDITION = "condition"
    ACTIVITY = "activity"
    APPROVAL_GATE = "approval-gate"
    TIMER = "timer"
    PUBLISH_EVENT = "publish-event"
    ADD = "add"


class SerializedNode(BaseModel):
    """Serialized node format for workflow definitions."""
    id: str
    type: str  # WorkflowNodeType as string
    label: str = ""
    description: str | None = None
    enabled: bool = True
    position: dict[str, float] = Field(default_factory=lambda: {"x": 0, "y": 0})
    config: dict[str, Any] = Field(default_factory=dict)

    class Config:
        extra = "allow"


class SerializedEdge(BaseModel):
    """Serialized edge format for workflow definitions."""
    id: str
    source: str
    target: str
    sourceHandle: str | None = None
    targetHandle: str | None = None

    class Config:
        extra = "allow"


class WorkflowMetadata(BaseModel):
    """Metadata for the workflow."""
    description: str | None = None
    author: str | None = None
    tags: list[str] | None = None


class WorkflowDefinition(BaseModel):
    """Complete workflow definition that can be stored and executed."""
    id: str
    name: str
    version: str = "1.0.0"
    createdAt: str | None = None
    updatedAt: str | None = None
    nodes: list[SerializedNode]
    edges: list[SerializedEdge]
    executionOrder: list[str] = Field(default_factory=list, description="Topologically sorted node IDs")
    metadata: WorkflowMetadata | None = None


class WorkflowPhase(str, Enum):
    """Workflow execution phases."""
    PENDING = "pending"
    RUNNING = "running"
    AWAITING_APPROVAL = "awaiting_approval"
    COMPLETED = "completed"
    FAILED = "failed"
    REJECTED = "rejected"
    TIMED_OUT = "timed_out"
    CANCELLED = "cancelled"


class DynamicWorkflowInput(BaseModel):
    """Input to the dynamic workflow function."""
    definition: WorkflowDefinition
    triggerData: dict[str, Any] = Field(default_factory=dict)
    integrations: dict[str, dict[str, str]] | None = None
    dbExecutionId: str | None = Field(
        default=None,
        description="Database execution ID for logging (links to workflow_executions.id)"
    )


class DynamicWorkflowOutput(BaseModel):
    """Output from the dynamic workflow function."""
    success: bool
    outputs: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    durationMs: int = 0
    phase: str = "completed"


class WorkflowCustomStatus(BaseModel):
    """Custom status stored in Dapr workflow state."""
    phase: str = "pending"
    progress: int = 0  # 0-100
    message: str | None = None
    currentNodeId: str | None = None
    currentNodeName: str | None = None


class ActivityExecutionResult(BaseModel):
    """Activity execution result from services."""
    success: bool
    data: Any | None = None
    error: str | None = None
    duration_ms: int = 0


class ApprovalGateConfig(BaseModel):
    """Approval gate configuration."""
    eventName: str
    timeoutSeconds: int | None = None
    timeoutHours: int | None = None
    approvers: list[str] | None = None
    message: str | None = None


class TimerConfig(BaseModel):
    """Timer configuration."""
    durationSeconds: int | None = None
    durationMinutes: int | None = None
    durationHours: int | None = None


class ActionNodeConfig(BaseModel):
    """Action node configuration."""
    actionType: str | None = None
    actionId: str | None = None
    activityName: str | None = None
    integrationId: str | None = None

    class Config:
        extra = "allow"
