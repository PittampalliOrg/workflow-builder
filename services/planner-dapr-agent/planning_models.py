"""Pydantic models for the OpenAI Agents SDK planning system.

This module defines all the data models used by the multi-agent planning
system, including research plans, agent results, and Claude Code compatible
task outputs.

The models support:
- Structured outputs from OpenAI Agents SDK
- DAG validation for task dependencies
- Topological sorting for execution order
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator


# ============================================================================
# Research Plan Models (Orchestrator Output)
# ============================================================================


class QueryType(str, Enum):
    """Types of research queries."""
    FILE_SEARCH = "file_search"
    PATTERN_SEARCH = "pattern_search"
    ARCHITECTURE = "architecture"
    DEPENDENCY = "dependency"
    API_LOOKUP = "api_lookup"
    BEST_PRACTICES = "best_practices"


class ResearchQuery(BaseModel):
    """A single research query to be executed by a specialized agent."""

    id: str = Field(description="Unique identifier for this query")
    query_type: QueryType = Field(description="Type of research query")
    query: str = Field(description="The actual query/command to execute")
    target_path: str = Field(default=".", description="Target path for file operations")
    rationale: str = Field(description="Why this query is needed")


class ResearchPlan(BaseModel):
    """Research plan created by the orchestrator agent.

    Contains a summary of the feature request and a list of queries
    to be executed by specialized research agents.
    """

    feature_summary: str = Field(
        description="Brief summary of what the feature request is asking for"
    )
    research_queries: List[ResearchQuery] = Field(
        description="List of research queries to execute"
    )
    key_questions: List[str] = Field(
        description="Key questions that need to be answered to implement this feature"
    )


# ============================================================================
# Research Result Models (Agent Outputs)
# ============================================================================


class FileDiscovery(BaseModel):
    """Information about a discovered file."""

    path: str = Field(description="Path to the file relative to workspace")
    purpose: str = Field(description="Inferred purpose of the file")
    relevance: str = Field(description="Why this file is relevant to the feature")
    key_exports: List[str] = Field(
        default_factory=list,
        description="Key classes, functions, or exports from this file"
    )


class CodebaseExplorerResult(BaseModel):
    """Result from the codebase explorer agent."""

    query_id: str = Field(description="ID of the query this result is for")
    discovered_files: List[FileDiscovery] = Field(
        default_factory=list,
        description="Files discovered during exploration"
    )
    directory_structure: Dict[str, List[str]] = Field(
        default_factory=dict,
        description="Mapping of directories to their contents"
    )
    entry_points: List[str] = Field(
        default_factory=list,
        description="Identified entry points (main files, routers, etc.)"
    )
    summary: str = Field(default="", description="Summary of findings")


class DependencyInfo(BaseModel):
    """Information about a code dependency."""

    source_file: str = Field(description="File that has the dependency")
    imports: List[str] = Field(description="What is imported")
    dependency_type: str = Field(
        description="Type: internal, external_package, relative"
    )


class IntegrationPoint(BaseModel):
    """An integration point in the codebase."""

    location: str = Field(description="File and line/function where integration happens")
    description: str = Field(description="What this integration point does")
    connects_to: List[str] = Field(description="What components it connects to")


class ArchitectureAnalyzerResult(BaseModel):
    """Result from the architecture analyzer agent."""

    query_id: str = Field(description="ID of the query this result is for")
    dependencies: List[DependencyInfo] = Field(
        default_factory=list,
        description="Discovered dependencies"
    )
    integration_points: List[IntegrationPoint] = Field(
        default_factory=list,
        description="Identified integration points"
    )
    architectural_constraints: List[str] = Field(
        default_factory=list,
        description="Constraints that must be respected"
    )
    patterns_used: List[str] = Field(
        default_factory=list,
        description="Design patterns identified in the codebase"
    )
    summary: str = Field(default="", description="Summary of architecture analysis")


class CodePattern(BaseModel):
    """A code pattern found in the codebase."""

    name: str = Field(description="Name/description of the pattern")
    example_location: str = Field(description="File:line where this pattern is used")
    code_snippet: str = Field(description="Example code showing the pattern")
    when_to_use: str = Field(description="When to apply this pattern")


class PatternFinderResult(BaseModel):
    """Result from the pattern finder agent."""

    query_id: str = Field(description="ID of the query this result is for")
    similar_features: List[Dict[str, str]] = Field(
        default_factory=list,
        description="Similar features found in the codebase"
    )
    code_patterns: List[CodePattern] = Field(
        default_factory=list,
        description="Code patterns that should be followed"
    )
    naming_conventions: Dict[str, str] = Field(
        default_factory=dict,
        description="Naming conventions used (e.g., {'files': 'snake_case', 'classes': 'PascalCase'})"
    )
    testing_patterns: List[str] = Field(
        default_factory=list,
        description="Testing patterns used in the codebase"
    )
    summary: str = Field(default="", description="Summary of pattern findings")


class AggregatedResearch(BaseModel):
    """Aggregated results from all research agents."""

    codebase_results: List[CodebaseExplorerResult] = Field(default_factory=list)
    architecture_results: List[ArchitectureAnalyzerResult] = Field(default_factory=list)
    pattern_results: List[PatternFinderResult] = Field(default_factory=list)

    def to_summary(self) -> str:
        """Generate a text summary for the task planner."""
        parts = []

        # Codebase findings
        if self.codebase_results:
            parts.append("## Codebase Exploration Results\n")
            for result in self.codebase_results:
                parts.append(f"### Query: {result.query_id}\n")
                parts.append(f"{result.summary}\n")
                if result.discovered_files:
                    parts.append("Key files:\n")
                    for f in result.discovered_files[:10]:
                        parts.append(f"- {f.path}: {f.purpose}\n")
                if result.entry_points:
                    parts.append(f"Entry points: {', '.join(result.entry_points)}\n")
                parts.append("\n")

        # Architecture findings
        if self.architecture_results:
            parts.append("## Architecture Analysis Results\n")
            for result in self.architecture_results:
                parts.append(f"### Query: {result.query_id}\n")
                parts.append(f"{result.summary}\n")
                if result.architectural_constraints:
                    parts.append("Constraints:\n")
                    for c in result.architectural_constraints:
                        parts.append(f"- {c}\n")
                if result.patterns_used:
                    parts.append(f"Patterns: {', '.join(result.patterns_used)}\n")
                parts.append("\n")

        # Pattern findings
        if self.pattern_results:
            parts.append("## Pattern Analysis Results\n")
            for result in self.pattern_results:
                parts.append(f"### Query: {result.query_id}\n")
                parts.append(f"{result.summary}\n")
                if result.naming_conventions:
                    parts.append("Naming conventions:\n")
                    for k, v in result.naming_conventions.items():
                        parts.append(f"- {k}: {v}\n")
                if result.code_patterns:
                    parts.append("Code patterns to follow:\n")
                    for p in result.code_patterns[:5]:
                        parts.append(f"- {p.name}: {p.when_to_use}\n")
                parts.append("\n")

        return "".join(parts)


# ============================================================================
# Task Plan Models (Claude Code Compatible Output)
# ============================================================================


class TaskStatus(str, Enum):
    """Status of a task."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class ClaudeCodeTask(BaseModel):
    """A task compatible with Claude Code's native task system.

    This model matches the schema expected by Claude Code's TaskCreate/TaskUpdate
    tools, with additional fields for enhanced planning.
    """

    id: str = Field(description="Unique task identifier (numeric string)")
    subject: str = Field(
        description="Brief imperative title (e.g., 'Create module structure')"
    )
    description: str = Field(
        description="Detailed implementation instructions"
    )
    activeForm: str = Field(
        description="Present continuous form for spinner (e.g., 'Creating module structure')"
    )
    status: TaskStatus = Field(
        default=TaskStatus.PENDING,
        description="Task status"
    )
    blockedBy: List[str] = Field(
        default_factory=list,
        description="Task IDs that must complete before this task can start"
    )
    blocks: List[str] = Field(
        default_factory=list,
        description="Task IDs that cannot start until this task completes"
    )

    # Extended fields for better planning
    files_to_modify: List[str] = Field(
        default_factory=list,
        description="Files that will be created or modified"
    )
    acceptance_criteria: List[str] = Field(
        default_factory=list,
        description="Criteria for considering this task complete"
    )
    estimated_complexity: str = Field(
        default="medium",
        description="Complexity: low, medium, high"
    )

    def to_claude_code_format(self) -> Dict[str, Any]:
        """Convert to the format expected by Claude Code's task system."""
        return {
            "id": self.id,
            "subject": self.subject,
            "description": self.description,
            "activeForm": self.activeForm,
            "status": self.status.value,
            "blockedBy": self.blockedBy,
            "blocks": self.blocks,
        }


class TaskPlan(BaseModel):
    """Complete task plan with Claude Code compatible tasks.

    This model represents the final output of the planning process,
    containing all tasks with their dependencies properly defined.
    """

    summary: str = Field(
        description="Brief summary of the implementation plan"
    )
    tasks: List[ClaudeCodeTask] = Field(
        description="Ordered list of tasks to implement"
    )
    reasoning: str = Field(
        description="Explanation of why this plan was chosen"
    )
    affected_areas: List[str] = Field(
        default_factory=list,
        description="Areas of the codebase that will be affected"
    )

    @model_validator(mode="after")
    def validate_dependency_graph(self) -> "TaskPlan":
        """Validate that the dependency graph is valid (no cycles, valid IDs)."""
        task_ids = {t.id for t in self.tasks}

        # Check all referenced IDs exist
        for task in self.tasks:
            for blocked_by_id in task.blockedBy:
                if blocked_by_id not in task_ids:
                    raise ValueError(
                        f"Task {task.id} references non-existent task {blocked_by_id} in blockedBy"
                    )
            for blocks_id in task.blocks:
                if blocks_id not in task_ids:
                    raise ValueError(
                        f"Task {task.id} references non-existent task {blocks_id} in blocks"
                    )

        # Check for cycles using DFS
        def has_cycle(task_id: str, visited: set, rec_stack: set) -> bool:
            visited.add(task_id)
            rec_stack.add(task_id)

            task = next(t for t in self.tasks if t.id == task_id)
            for blocked_id in task.blockedBy:
                if blocked_id not in visited:
                    if has_cycle(blocked_id, visited, rec_stack):
                        return True
                elif blocked_id in rec_stack:
                    return True

            rec_stack.remove(task_id)
            return False

        visited: set[str] = set()
        for task in self.tasks:
            if task.id not in visited:
                if has_cycle(task.id, visited, set()):
                    raise ValueError("Circular dependency detected in task graph")

        return self

    def populate_blocks(self) -> None:
        """Auto-populate blocks from blockedBy relationships.

        This ensures bidirectional consistency: if task B has blockedBy=[A],
        then task A should have blocks containing B.
        """
        # Build reverse mapping
        blocks_map: Dict[str, set] = {t.id: set(t.blocks) for t in self.tasks}

        for task in self.tasks:
            for blocked_by_id in task.blockedBy:
                blocks_map[blocked_by_id].add(task.id)

        # Update tasks
        for task in self.tasks:
            task.blocks = sorted(blocks_map[task.id])

    def topological_order(self) -> List[ClaudeCodeTask]:
        """Return tasks in topological order (Kahn's algorithm).

        Tasks with no dependencies come first, followed by tasks
        whose dependencies have all been satisfied.
        """
        # Build adjacency and in-degree
        in_degree: Dict[str, int] = {t.id: len(t.blockedBy) for t in self.tasks}
        task_map = {t.id: t for t in self.tasks}

        # Start with tasks that have no dependencies
        queue = [tid for tid, deg in in_degree.items() if deg == 0]
        result = []

        while queue:
            # Sort to ensure deterministic order
            queue.sort()
            task_id = queue.pop(0)
            result.append(task_map[task_id])

            # Reduce in-degree of dependent tasks
            for task in self.tasks:
                if task_id in task.blockedBy:
                    in_degree[task.id] -= 1
                    if in_degree[task.id] == 0:
                        queue.append(task.id)

        if len(result) != len(self.tasks):
            raise ValueError("Could not complete topological sort - cycle detected")

        return result

    def to_claude_code_format(self) -> List[Dict[str, Any]]:
        """Convert all tasks to Claude Code format."""
        return [t.to_claude_code_format() for t in self.tasks]


# ============================================================================
# Workflow Input/Output Models
# ============================================================================


class PlanningRequest(BaseModel):
    """Request to start a planning workflow."""

    feature_request: str = Field(
        description="Description of the feature to implement"
    )
    workspace_dir: str = Field(
        default="/app/workspace",
        description="Path to the workspace directory"
    )
    model: str = Field(
        default="gpt-4o",
        description="Model to use for planning agents"
    )
    max_tasks: int = Field(
        default=15,
        description="Maximum number of tasks to generate"
    )


class PlanningResult(BaseModel):
    """Result of a planning workflow."""

    success: bool = Field(description="Whether planning succeeded")
    workflow_id: str = Field(description="Unique workflow identifier")
    phase: str = Field(description="Current phase of the workflow")
    tasks: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Generated tasks in Claude Code format"
    )
    plan: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Full plan details including reasoning"
    )
    error: Optional[str] = Field(
        default=None,
        description="Error message if planning failed"
    )
