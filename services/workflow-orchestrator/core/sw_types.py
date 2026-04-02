"""
CNCF Serverless Workflow 1.0 Pydantic Models

Based on the official specification:
https://github.com/serverlessworkflow/specification/tree/main/dsl-reference

These models define the complete SW 1.0 document structure for parsing,
validation, and execution within the Dapr workflow orchestrator.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Union

from pydantic import BaseModel, Field


SW_DSL_VERSION = "1.0.0"


# ---------------------------------------------------------------------------
# Document metadata
# ---------------------------------------------------------------------------

class WorkflowDocument(BaseModel):
    """Top-level document metadata."""
    dsl: str = SW_DSL_VERSION
    namespace: str
    name: str
    version: str
    title: str | None = None
    summary: str | None = None
    tags: dict[str, str] | None = None


# ---------------------------------------------------------------------------
# Input / Output / Export
# ---------------------------------------------------------------------------

class SchemaDefinition(BaseModel):
    format: str | None = None
    document: Any | None = None

    class Config:
        extra = "allow"


class InputDefinition(BaseModel):
    schema_: SchemaDefinition | None = Field(None, alias="schema")
    from_: str | dict[str, Any] | None = Field(None, alias="from")

    class Config:
        extra = "allow"
        populate_by_name = True


class OutputDefinition(BaseModel):
    schema_: SchemaDefinition | None = Field(None, alias="schema")
    as_: str | dict[str, Any] | None = Field(None, alias="as")

    class Config:
        extra = "allow"
        populate_by_name = True


class ExportDefinition(BaseModel):
    schema_: SchemaDefinition | None = Field(None, alias="schema")
    as_: str | dict[str, Any] | None = Field(None, alias="as")

    class Config:
        extra = "allow"
        populate_by_name = True


# ---------------------------------------------------------------------------
# Use definitions (reusable components)
# ---------------------------------------------------------------------------

class FunctionDefinition(BaseModel):
    call: str
    with_: dict[str, Any] | None = Field(None, alias="with")

    class Config:
        extra = "allow"
        populate_by_name = True


class ErrorDefinition(BaseModel):
    type: str
    status: int
    title: str | None = None
    detail: str | None = None
    instance: str | None = None


class RetryDefinition(BaseModel):
    when: str | None = None
    except_when: str | None = Field(None, alias="exceptWhen")
    delay: str | dict[str, Any] | None = None
    limit: dict[str, Any] | None = None
    jitter: dict[str, Any] | None = None

    class Config:
        extra = "allow"
        populate_by_name = True


class TimeoutDefinition(BaseModel):
    after: str | dict[str, Any]


class UseDefinition(BaseModel):
    """Reusable component definitions."""
    authentications: dict[str, dict[str, Any]] | None = None
    errors: dict[str, ErrorDefinition] | None = None
    extensions: list[dict[str, Any]] | None = None
    functions: dict[str, FunctionDefinition] | None = None
    retries: dict[str, RetryDefinition] | None = None
    secrets: list[str] | None = None
    timeouts: dict[str, TimeoutDefinition] | None = None
    catalogs: dict[str, dict[str, Any]] | None = None

    class Config:
        extra = "allow"


# ---------------------------------------------------------------------------
# Duration
# ---------------------------------------------------------------------------

Duration = str | dict[str, int | float]


# ---------------------------------------------------------------------------
# Task types
# ---------------------------------------------------------------------------

class TaskType(str, Enum):
    """The 12 unified task types of SW 1.0."""
    CALL = "call"
    DO = "do"
    EMIT = "emit"
    FOR = "for"
    FORK = "fork"
    LISTEN = "listen"
    RAISE = "raise"
    RUN = "run"
    SET = "set"
    SWITCH = "switch"
    TRY = "try"
    WAIT = "wait"


class TaskBase(BaseModel):
    """Fields shared by all tasks."""
    if_: str | None = Field(None, alias="if")
    input: InputDefinition | None = None
    output: OutputDefinition | None = None
    export: ExportDefinition | None = None
    timeout: dict[str, Any] | None = None
    then: str | None = None  # FlowDirective: "continue" | "exit" | "end" | <taskName>
    metadata: dict[str, Any] | None = None

    class Config:
        extra = "allow"
        populate_by_name = True


# -- Call tasks ---

class CallHTTPTask(TaskBase):
    call: Literal["http"]
    with_: dict[str, Any] = Field(alias="with")

    class Config:
        extra = "allow"
        populate_by_name = True


class CallGRPCTask(TaskBase):
    call: Literal["grpc"]
    with_: dict[str, Any] = Field(alias="with")

    class Config:
        extra = "allow"
        populate_by_name = True


class CallOpenAPITask(TaskBase):
    call: Literal["openapi"]
    with_: dict[str, Any] = Field(alias="with")

    class Config:
        extra = "allow"
        populate_by_name = True


class CallAsyncAPITask(TaskBase):
    call: Literal["asyncapi"]
    with_: dict[str, Any] = Field(alias="with")

    class Config:
        extra = "allow"
        populate_by_name = True


class CallFunctionTask(TaskBase):
    """Call a user-defined function from use.functions."""
    call: str  # function name
    with_: dict[str, Any] | None = Field(None, alias="with")

    class Config:
        extra = "allow"
        populate_by_name = True


# -- Do task ---

class DoTask(TaskBase):
    do: list[dict[str, Any]]  # TaskItem[]

    class Config:
        extra = "allow"


# -- Fork task ---

class ForkDefinition(BaseModel):
    branches: list[dict[str, Any]]
    compete: bool | None = None

    class Config:
        extra = "allow"


class ForkTask(TaskBase):
    fork: ForkDefinition

    class Config:
        extra = "allow"


# -- Emit task ---

class EmitTask(TaskBase):
    emit: dict[str, Any]

    class Config:
        extra = "allow"


# -- For task ---

class ForDefinition(BaseModel):
    each: str | None = None
    in_: str | None = Field(None, alias="in")
    at: str | None = None

    class Config:
        extra = "allow"
        populate_by_name = True


class ForTask(TaskBase):
    for_: ForDefinition = Field(alias="for")
    while_: str | None = Field(None, alias="while")
    do: list[dict[str, Any]] = Field(default_factory=list)

    class Config:
        extra = "allow"
        populate_by_name = True


# -- Listen task ---

class ListenTask(TaskBase):
    listen: dict[str, Any]

    class Config:
        extra = "allow"


# -- Raise task ---

class RaiseTask(TaskBase):
    raise_: dict[str, Any] = Field(alias="raise")

    class Config:
        extra = "allow"
        populate_by_name = True


# -- Run task ---

class RunTask(TaskBase):
    run: dict[str, Any]

    class Config:
        extra = "allow"


# -- Set task ---

class SetTask(TaskBase):
    set: dict[str, Any]

    class Config:
        extra = "allow"


# -- Switch task ---

class SwitchCaseDefinition(BaseModel):
    when: str | None = None
    then: str | None = None

    class Config:
        extra = "allow"


class SwitchTask(TaskBase):
    switch: list[dict[str, SwitchCaseDefinition]]

    class Config:
        extra = "allow"


# -- Try task ---

class CatchDefinition(BaseModel):
    errors: dict[str, Any] | None = None
    as_: str | None = Field(None, alias="as")
    when: str | None = None
    except_when: str | None = Field(None, alias="exceptWhen")
    retry: str | dict[str, Any] | None = None
    do: list[dict[str, Any]] | None = None

    class Config:
        extra = "allow"
        populate_by_name = True


class TryTask(TaskBase):
    try_: list[dict[str, Any]] = Field(alias="try")
    catch: CatchDefinition

    class Config:
        extra = "allow"
        populate_by_name = True


# -- Wait task ---

class WaitTask(TaskBase):
    wait: str | dict[str, Any]  # Duration

    class Config:
        extra = "allow"


# ---------------------------------------------------------------------------
# Task discriminator
# ---------------------------------------------------------------------------

# TaskItem is a dict with a single key (task name) mapping to a task dict.
TaskItem = dict[str, dict[str, Any]]


def get_task_type(task: dict[str, Any]) -> TaskType:
    """Determine the task type from a raw task dict."""
    if "call" in task:
        return TaskType.CALL
    if "fork" in task:
        return TaskType.FORK
    if "emit" in task:
        return TaskType.EMIT
    if "for" in task:
        return TaskType.FOR
    if "listen" in task:
        return TaskType.LISTEN
    if "raise" in task:
        return TaskType.RAISE
    if "run" in task:
        return TaskType.RUN
    if "set" in task:
        return TaskType.SET
    if "switch" in task:
        return TaskType.SWITCH
    if "try" in task:
        return TaskType.TRY
    if "wait" in task:
        return TaskType.WAIT
    if "do" in task:
        return TaskType.DO
    raise ValueError(f"Unknown task type with keys: {list(task.keys())}")


def parse_task(task_type: TaskType, data: dict[str, Any]):
    """Parse a raw task dict into the appropriate typed model."""
    match task_type:
        case TaskType.CALL:
            call_value = data.get("call", "")
            if call_value == "http":
                return CallHTTPTask.model_validate(data)
            if call_value == "grpc":
                return CallGRPCTask.model_validate(data)
            if call_value == "openapi":
                return CallOpenAPITask.model_validate(data)
            if call_value == "asyncapi":
                return CallAsyncAPITask.model_validate(data)
            return CallFunctionTask.model_validate(data)
        case TaskType.DO:
            return DoTask.model_validate(data)
        case TaskType.EMIT:
            return EmitTask.model_validate(data)
        case TaskType.FOR:
            return ForTask.model_validate(data)
        case TaskType.FORK:
            return ForkTask.model_validate(data)
        case TaskType.LISTEN:
            return ListenTask.model_validate(data)
        case TaskType.RAISE:
            return RaiseTask.model_validate(data)
        case TaskType.RUN:
            return RunTask.model_validate(data)
        case TaskType.SET:
            return SetTask.model_validate(data)
        case TaskType.SWITCH:
            return SwitchTask.model_validate(data)
        case TaskType.TRY:
            return TryTask.model_validate(data)
        case TaskType.WAIT:
            return WaitTask.model_validate(data)


# ---------------------------------------------------------------------------
# Top-level Workflow model
# ---------------------------------------------------------------------------

class Workflow(BaseModel):
    """Complete CNCF Serverless Workflow 1.0 document."""
    document: WorkflowDocument
    input: InputDefinition | None = None
    output: OutputDefinition | None = None
    use: UseDefinition | None = None
    do: list[TaskItem]
    timeout: dict[str, Any] | None = None
    schedule: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None

    class Config:
        extra = "allow"

    def unwrap_tasks(self) -> list[tuple[str, dict[str, Any]]]:
        """Walk the top-level `do` list and yield (name, task_dict) pairs."""
        result = []
        for item in self.do:
            for name, task_data in item.items():
                result.append((name, task_data))
        return result


# ---------------------------------------------------------------------------
# Orchestrator I/O models (Dapr integration)
# ---------------------------------------------------------------------------

class SWWorkflowInput(BaseModel):
    """Input to the SW 1.0 dynamic workflow function."""
    workflow: Workflow
    trigger_data: dict[str, Any] = Field(default_factory=dict, alias="triggerData")
    integrations: dict[str, dict[str, str]] | None = None
    db_execution_id: str | None = Field(
        None,
        alias="dbExecutionId",
        description="Database execution ID for logging",
    )

    class Config:
        populate_by_name = True


class SWWorkflowOutput(BaseModel):
    """Output from the SW 1.0 dynamic workflow function."""
    success: bool
    outputs: dict[str, Any] = Field(default_factory=dict)
    workflow_output: Any | None = Field(None, alias="workflowOutput")
    error: str | None = None
    duration_ms: int = Field(0, alias="durationMs")
    phase: str = "completed"

    class Config:
        populate_by_name = True


class SWWorkflowCustomStatus(BaseModel):
    """Custom status stored in Dapr workflow state.

    Field names match the legacy WorkflowCustomStatus so the UI status
    polling, the _build_workflow_status_payload helper, and the Runs
    sidebar all work without changes.
    """
    phase: str = "pending"
    progress: int = 0
    message: str | None = None
    # Legacy field names for UI compatibility
    currentNodeId: str | None = None
    currentNodeName: str | None = None

    class Config:
        populate_by_name = True
