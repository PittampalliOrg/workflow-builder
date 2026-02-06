"""Orchestration logic for the multi-agent planning workflow.

This module coordinates the execution of multiple specialized agents
to analyze a codebase and create an implementation plan.

The workflow follows the research_bot pattern:
1. Orchestrator creates a research plan
2. Research agents execute in parallel
3. Task planner synthesizes results into executable tasks

All agent execution uses asyncio.gather for maximum parallelism.
"""

import asyncio
import logging
from typing import Any, Callable, Dict, List, Optional

from agents import Runner

from planning_models import (
    ResearchPlan,
    ResearchQuery,
    QueryType,
    CodebaseExplorerResult,
    ArchitectureAnalyzerResult,
    PatternFinderResult,
    AggregatedResearch,
    TaskPlan,
    PlanningResult,
)
from planning_agents import (
    AgentConfig,
    create_orchestrator_agent,
    create_codebase_explorer_agent,
    create_architecture_analyzer_agent,
    create_pattern_finder_agent,
    create_task_planner_agent,
)


logger = logging.getLogger(__name__)


# Type alias for progress callbacks
ProgressCallback = Callable[[int, str], None]


async def run_agent_with_query(
    agent,
    query: ResearchQuery,
    progress_callback: Optional[ProgressCallback] = None,
) -> Any:
    """Run a single agent with a research query.

    Args:
        agent: The agent to run
        query: Research query to execute
        progress_callback: Optional callback for progress updates

    Returns:
        The agent's output (typed based on agent's output_type)
    """
    logger.info(f"Running agent {agent.name} for query {query.id}: {query.query}")

    if progress_callback:
        progress_callback(0, f"Running {agent.name} for: {query.query[:50]}...")

    # Format input for the agent
    input_text = f"""Research Query ID: {query.id}
Query Type: {query.query_type.value}
Query: {query.query}
Target Path: {query.target_path}
Rationale: {query.rationale}

Please execute this research query and return structured results."""

    try:
        result = await Runner.run(agent, input=input_text)
        logger.info(f"Agent {agent.name} completed query {query.id}")
        return result.final_output
    except Exception as e:
        logger.error(f"Agent {agent.name} failed for query {query.id}: {e}")
        # Return empty result on failure
        if hasattr(agent, "output_type"):
            if agent.output_type == CodebaseExplorerResult:
                return CodebaseExplorerResult(
                    query_id=query.id,
                    summary=f"Error: {str(e)}"
                )
            elif agent.output_type == ArchitectureAnalyzerResult:
                return ArchitectureAnalyzerResult(
                    query_id=query.id,
                    summary=f"Error: {str(e)}"
                )
            elif agent.output_type == PatternFinderResult:
                return PatternFinderResult(
                    query_id=query.id,
                    summary=f"Error: {str(e)}"
                )
        raise


async def run_parallel_research(
    research_plan: ResearchPlan,
    config: AgentConfig,
    progress_callback: Optional[ProgressCallback] = None,
) -> AggregatedResearch:
    """Execute research queries in parallel using asyncio.gather.

    Queries are categorized by type and routed to the appropriate
    specialized agent. All agents run concurrently for maximum speed.

    Args:
        research_plan: Plan containing queries to execute
        config: Agent configuration
        progress_callback: Optional callback for progress updates

    Returns:
        AggregatedResearch containing all agent results
    """
    logger.info(f"Starting parallel research with {len(research_plan.research_queries)} queries")

    if progress_callback:
        progress_callback(20, "Starting parallel research phase...")

    # Categorize queries by type
    file_queries = [
        q for q in research_plan.research_queries
        if q.query_type in (QueryType.FILE_SEARCH,)
    ]
    arch_queries = [
        q for q in research_plan.research_queries
        if q.query_type in (QueryType.ARCHITECTURE, QueryType.DEPENDENCY)
    ]
    pattern_queries = [
        q for q in research_plan.research_queries
        if q.query_type in (QueryType.PATTERN_SEARCH, QueryType.BEST_PRACTICES, QueryType.API_LOOKUP)
    ]

    # Create agents
    explorer = config.create_codebase_explorer()
    analyzer = config.create_architecture_analyzer()
    pattern_finder = config.create_pattern_finder()

    # Create tasks for each query
    explorer_tasks = [
        run_agent_with_query(explorer, q, progress_callback)
        for q in file_queries
    ]
    analyzer_tasks = [
        run_agent_with_query(analyzer, q, progress_callback)
        for q in arch_queries
    ]
    pattern_tasks = [
        run_agent_with_query(pattern_finder, q, progress_callback)
        for q in pattern_queries
    ]

    # Run all tasks in parallel
    all_tasks = explorer_tasks + analyzer_tasks + pattern_tasks
    task_count = len(all_tasks)

    if task_count == 0:
        logger.warning("No research queries to execute")
        return AggregatedResearch()

    logger.info(f"Executing {task_count} research tasks in parallel")
    if progress_callback:
        progress_callback(25, f"Running {task_count} research agents in parallel...")

    # Gather results with error handling
    results = await asyncio.gather(*all_tasks, return_exceptions=True)

    # Separate results by type
    explorer_count = len(explorer_tasks)
    analyzer_count = len(analyzer_tasks)

    explorer_results = []
    for i, r in enumerate(results[:explorer_count]):
        if isinstance(r, Exception):
            logger.error(f"Explorer task {i} failed: {r}")
            explorer_results.append(CodebaseExplorerResult(
                query_id=file_queries[i].id if i < len(file_queries) else "unknown",
                summary=f"Error: {str(r)}"
            ))
        else:
            explorer_results.append(r)

    analyzer_results = []
    for i, r in enumerate(results[explorer_count:explorer_count + analyzer_count]):
        if isinstance(r, Exception):
            logger.error(f"Analyzer task {i} failed: {r}")
            analyzer_results.append(ArchitectureAnalyzerResult(
                query_id=arch_queries[i].id if i < len(arch_queries) else "unknown",
                summary=f"Error: {str(r)}"
            ))
        else:
            analyzer_results.append(r)

    pattern_results = []
    for i, r in enumerate(results[explorer_count + analyzer_count:]):
        if isinstance(r, Exception):
            logger.error(f"Pattern task {i} failed: {r}")
            pattern_results.append(PatternFinderResult(
                query_id=pattern_queries[i].id if i < len(pattern_queries) else "unknown",
                summary=f"Error: {str(r)}"
            ))
        else:
            pattern_results.append(r)

    if progress_callback:
        progress_callback(40, "Research phase completed")

    return AggregatedResearch(
        codebase_results=explorer_results,
        architecture_results=analyzer_results,
        pattern_results=pattern_results,
    )


async def run_planning_workflow(
    feature_request: str,
    model: str = "gpt-4o",
    workspace_dir: str = "/app/workspace",
    progress_callback: Optional[ProgressCallback] = None,
    max_tasks: int = 15,
) -> Dict[str, Any]:
    """Execute the full planning workflow.

    This is the main entry point for the planning system:
    1. Orchestrator analyzes the feature request
    2. Research agents explore the codebase in parallel
    3. Task planner creates executable tasks

    Args:
        feature_request: Description of the feature to implement
        model: OpenAI model to use (default: gpt-4o)
        workspace_dir: Path to the workspace
        progress_callback: Optional callback for progress updates
        max_tasks: Maximum number of tasks to generate

    Returns:
        Dictionary with tasks in Claude Code format and full plan details
    """
    logger.info(f"Starting planning workflow for: {feature_request[:100]}...")

    config = AgentConfig(model=model, workspace_dir=workspace_dir)

    # Phase 1: Create research plan
    if progress_callback:
        progress_callback(5, "Analyzing feature request...")

    logger.info("Phase 1: Creating research plan")
    orchestrator = config.create_orchestrator()

    orchestrator_input = f"""Feature Request:
{feature_request}

Workspace Directory: {workspace_dir}

Please analyze this feature request and create a research plan.
Do a quick initial exploration of the codebase structure first,
then create specific research queries for the specialized agents.
"""

    orchestrator_result = await Runner.run(orchestrator, input=orchestrator_input)
    research_plan: ResearchPlan = orchestrator_result.final_output

    logger.info(f"Research plan created with {len(research_plan.research_queries)} queries")
    if progress_callback:
        progress_callback(15, f"Created research plan with {len(research_plan.research_queries)} queries")

    # Phase 2: Parallel research
    logger.info("Phase 2: Executing parallel research")
    aggregated_research = await run_parallel_research(
        research_plan, config, progress_callback
    )

    # Phase 3: Task planning
    if progress_callback:
        progress_callback(45, "Synthesizing research into tasks...")

    logger.info("Phase 3: Creating task plan")
    task_planner = config.create_task_planner()

    # Format research summary for task planner
    research_summary = aggregated_research.to_summary()

    planner_input = f"""Feature Request:
{feature_request}

Workspace Directory: {workspace_dir}

Research Summary:
{research_summary}

Key Questions from Orchestrator:
{chr(10).join(f"- {q}" for q in research_plan.key_questions)}

Please create a task plan with {max_tasks} or fewer tasks.
Ensure proper dependency ordering using blockedBy.
Follow the patterns and conventions discovered in the research.
"""

    planner_result = await Runner.run(task_planner, input=planner_input)
    task_plan: TaskPlan = planner_result.final_output

    # Auto-populate blocks from blockedBy
    task_plan.populate_blocks()

    logger.info(f"Task plan created with {len(task_plan.tasks)} tasks")
    if progress_callback:
        progress_callback(50, f"Created plan with {len(task_plan.tasks)} tasks")

    # Convert to Claude Code format
    tasks_claude_format = task_plan.to_claude_code_format()

    return {
        "success": True,
        "tasks": tasks_claude_format,
        "plan": {
            "summary": task_plan.summary,
            "reasoning": task_plan.reasoning,
            "affected_areas": task_plan.affected_areas,
            "task_count": len(task_plan.tasks),
        },
        "research": {
            "feature_summary": research_plan.feature_summary,
            "query_count": len(research_plan.research_queries),
            "key_questions": research_plan.key_questions,
        },
    }


async def create_plan(
    feature_request: str,
    workflow_id: str,
    model: str = "gpt-4o",
    workspace_dir: str = "/app/workspace",
    progress_callback: Optional[ProgressCallback] = None,
) -> PlanningResult:
    """Create a planning result with error handling.

    This is a wrapper around run_planning_workflow that returns
    a structured PlanningResult.

    Args:
        feature_request: Description of the feature to implement
        workflow_id: Unique workflow identifier
        model: OpenAI model to use
        workspace_dir: Path to the workspace
        progress_callback: Optional callback for progress updates

    Returns:
        PlanningResult with success status and tasks/error
    """
    try:
        result = await run_planning_workflow(
            feature_request=feature_request,
            model=model,
            workspace_dir=workspace_dir,
            progress_callback=progress_callback,
        )

        return PlanningResult(
            success=True,
            workflow_id=workflow_id,
            phase="planned",
            tasks=result["tasks"],
            plan=result["plan"],
        )

    except Exception as e:
        logger.exception(f"Planning workflow failed: {e}")
        return PlanningResult(
            success=False,
            workflow_id=workflow_id,
            phase="failed",
            error=str(e),
        )


# ============================================================================
# Synchronous wrapper for Dapr activities
# ============================================================================


def run_planning_workflow_sync(
    feature_request: str,
    model: str = "gpt-4o",
    workspace_dir: str = "/app/workspace",
    progress_callback: Optional[ProgressCallback] = None,
) -> Dict[str, Any]:
    """Synchronous wrapper for run_planning_workflow.

    This is useful for calling from Dapr workflow activities which
    may not support async directly.

    Args:
        feature_request: Description of the feature to implement
        model: OpenAI model to use
        workspace_dir: Path to the workspace
        progress_callback: Optional callback for progress updates

    Returns:
        Dictionary with tasks in Claude Code format and full plan details
    """
    return asyncio.run(run_planning_workflow(
        feature_request=feature_request,
        model=model,
        workspace_dir=workspace_dir,
        progress_callback=progress_callback,
    ))
