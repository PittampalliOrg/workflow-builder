"""OpenAI Agents SDK agent definitions for the research bot planning system.

This module defines all the specialized agents used in the multi-agent
planning workflow:

1. Orchestrator Agent - Analyzes feature requests and creates research plans
2. Codebase Explorer Agent - Discovers files and directory structure
3. Architecture Analyzer Agent - Analyzes dependencies and integration points
4. Pattern Finder Agent - Finds similar features and coding patterns
5. Task Planner Agent - Synthesizes research into executable tasks

Each agent uses native OpenAI SDK tools (ShellTool via function_tool,
WebSearchTool) for exploration.
"""

import os
from typing import Optional

from agents import Agent, WebSearchTool

from planning_models import (
    ResearchPlan,
    CodebaseExplorerResult,
    ArchitectureAnalyzerResult,
    PatternFinderResult,
    TaskPlan,
)
from shell_executor import (
    create_shell_tool,
    create_file_reader_tool,
    create_search_tool,
)


# Default workspace directory
DEFAULT_CWD = os.getenv("PLANNER_CWD", "/app/workspace")


# ============================================================================
# Agent Instructions
# ============================================================================

ORCHESTRATOR_INSTRUCTIONS = """You are a Research Orchestrator agent. Your job is to analyze a feature request and create a structured research plan.

When given a feature request, you should:

1. **Understand the Request**: Parse the feature request to understand what needs to be built.

2. **Identify Research Needs**: Determine what information you need about the codebase:
   - Which files/directories need to be explored?
   - What patterns should be identified?
   - What dependencies need to be understood?
   - What APIs or documentation should be consulted?

3. **Create Research Queries**: Generate specific queries for each specialized agent:
   - `file_search`: Find relevant files (use find, ls commands)
   - `pattern_search`: Find code patterns (use grep)
   - `architecture`: Analyze imports and dependencies
   - `dependency`: Check package dependencies
   - `api_lookup`: Search for API documentation
   - `best_practices`: Search for best practices

4. **Use Tools for Initial Exploration**: Use the shell tool to do a quick initial exploration:
   - `ls -la` to see top-level structure
   - `find . -type f -name "*.py"` to find Python files
   - `cat package.json` or `cat requirements.txt` to see dependencies

5. **Output a Research Plan**: Return a structured ResearchPlan with:
   - A summary of the feature request
   - A list of research queries for the specialized agents
   - Key questions that need to be answered

Be thorough but focused. Create queries that will help the specialized agents gather the information needed to create a good implementation plan.
"""

CODEBASE_EXPLORER_INSTRUCTIONS = """You are a Codebase Explorer agent. Your job is to discover files and understand the directory structure of a codebase.

Given a research query, use the shell tool to explore the codebase:

**Common Commands**:
- `ls -la [path]` - List directory contents
- `find . -type f -name "*.py"` - Find files by extension
- `find . -type d -name "tests"` - Find directories by name
- `tree -L 3` - Show directory tree (if available)
- `cat [file]` - Read file contents

**What to Look For**:
1. **Entry Points**: main.py, app.py, index.ts, etc.
2. **Module Structure**: How is the code organized?
3. **Test Files**: Where are tests located?
4. **Configuration**: Config files, .env examples
5. **Documentation**: README, docs folder

**Output Requirements**:
Return a CodebaseExplorerResult with:
- discovered_files: List of relevant files with their purpose
- directory_structure: Key directories and their contents
- entry_points: Main entry points of the application
- summary: Brief summary of what you found

Focus on files relevant to the research query. Don't list every file - prioritize what's most relevant for implementing the requested feature.
"""

ARCHITECTURE_ANALYZER_INSTRUCTIONS = """You are an Architecture Analyzer agent. Your job is to understand the architecture, dependencies, and integration points of a codebase.

Given a research query, analyze the codebase architecture:

**Commands to Use**:
- `grep -r "import " --include="*.py"` - Find Python imports
- `grep -r "from .* import" --include="*.py"` - Find Python from-imports
- `grep -r "require(" --include="*.js"` - Find JS requires
- `cat package.json` - Check JS dependencies
- `cat requirements.txt` or `cat pyproject.toml` - Check Python dependencies
- `grep -r "class " --include="*.py"` - Find class definitions
- `grep -r "def " --include="*.py"` - Find function definitions

**What to Analyze**:
1. **Dependencies**: What external packages are used?
2. **Internal Structure**: How do modules depend on each other?
3. **Integration Points**: Where does data flow between components?
4. **Patterns**: What design patterns are used (MVC, Repository, etc.)?
5. **Constraints**: What architectural constraints exist?

**Output Requirements**:
Return an ArchitectureAnalyzerResult with:
- dependencies: List of dependencies (internal and external)
- integration_points: Where components connect
- architectural_constraints: Rules that must be followed
- patterns_used: Design patterns identified
- summary: Brief summary of the architecture

Focus on information relevant to implementing new features safely.
"""

PATTERN_FINDER_INSTRUCTIONS = """You are a Pattern Finder agent. Your job is to identify coding patterns, naming conventions, and similar features in a codebase.

Given a research query, find patterns that should be followed:

**Commands to Use**:
- `grep -r "def test_" --include="*.py"` - Find test patterns
- `grep -r "@app.route" --include="*.py"` - Find route patterns
- `grep -r "class.*Model" --include="*.py"` - Find model patterns
- `grep -A 5 "class " [file]` - Get class definitions with context
- `head -50 [file]` - Read file headers for conventions

**What to Find**:
1. **Similar Features**: Features similar to what's being requested
2. **Code Patterns**: How similar code is structured
3. **Naming Conventions**: How files, classes, functions are named
4. **Testing Patterns**: How tests are written
5. **Error Handling**: How errors are handled

**Output Requirements**:
Return a PatternFinderResult with:
- similar_features: Features that are similar to what's requested
- code_patterns: Patterns that should be followed
- naming_conventions: Naming rules (files, classes, functions)
- testing_patterns: How to write tests
- summary: Brief summary of patterns found

When using web search, look for best practices for the technologies being used.
"""

TASK_PLANNER_INSTRUCTIONS = """You are a Task Planner agent. Your job is to synthesize research findings into a concrete implementation plan with tasks.

Given aggregated research results, create a TaskPlan that:

1. **Analyzes Research**: Understand what was discovered about the codebase.

2. **Designs Implementation**: Plan how to implement the feature:
   - What files need to be created/modified?
   - What's the correct order of operations?
   - What dependencies exist between tasks?

3. **Creates Tasks**: Generate 5-15 tasks that:
   - Are specific and actionable
   - Have clear acceptance criteria
   - Respect discovered patterns and conventions
   - Have proper dependency ordering (blockedBy)
   - Can be completed independently once dependencies are met

**Task Quality Guidelines**:
- **subject**: Imperative form, 5-10 words (e.g., "Create user authentication module")
- **description**: Detailed instructions including:
  - Specific files to create/modify
  - Functions/classes to implement
  - Patterns to follow (from research)
  - Acceptance criteria
- **activeForm**: Present continuous (e.g., "Creating user authentication module")
- **blockedBy**: List task IDs that must complete first
- **files_to_modify**: Specific file paths

**Dependency Rules**:
- Infrastructure tasks (config, setup) come first
- Core functionality before consumers
- Tests can parallel implementation but should depend on what they test
- Documentation comes last

**Output Requirements**:
Return a TaskPlan with:
- summary: Brief overview of the plan
- tasks: List of ClaudeCodeTask objects with proper dependencies
- reasoning: Why this plan was chosen
- affected_areas: Parts of codebase that will change

Create tasks that a developer can execute sequentially, with each task having everything needed to complete it.
"""


# ============================================================================
# Agent Factory Functions
# ============================================================================


def create_orchestrator_agent(
    model: str = "gpt-4o",
    workspace_dir: str = DEFAULT_CWD,
) -> Agent:
    """Create the orchestrator agent that analyzes requests and creates research plans.

    The orchestrator uses shell tools for initial exploration and web search
    for API/documentation lookup.

    Args:
        model: OpenAI model to use
        workspace_dir: Working directory for shell commands

    Returns:
        Configured Agent instance
    """
    return Agent(
        name="ResearchOrchestrator",
        model=model,
        instructions=ORCHESTRATOR_INSTRUCTIONS,
        tools=[
            create_shell_tool(workspace_dir),
            create_file_reader_tool(workspace_dir),
            WebSearchTool(),
        ],
        output_type=ResearchPlan,
    )


def create_codebase_explorer_agent(
    model: str = "gpt-4o",
    workspace_dir: str = DEFAULT_CWD,
) -> Agent:
    """Create the codebase explorer agent for file discovery.

    Args:
        model: OpenAI model to use
        workspace_dir: Working directory for shell commands

    Returns:
        Configured Agent instance
    """
    return Agent(
        name="CodebaseExplorer",
        model=model,
        instructions=CODEBASE_EXPLORER_INSTRUCTIONS,
        tools=[
            create_shell_tool(workspace_dir),
            create_file_reader_tool(workspace_dir),
        ],
        output_type=CodebaseExplorerResult,
    )


def create_architecture_analyzer_agent(
    model: str = "gpt-4o",
    workspace_dir: str = DEFAULT_CWD,
) -> Agent:
    """Create the architecture analyzer agent.

    Uses shell tools for code analysis and search.

    Args:
        model: OpenAI model to use
        workspace_dir: Working directory for shell commands

    Returns:
        Configured Agent instance
    """
    return Agent(
        name="ArchitectureAnalyzer",
        model=model,
        instructions=ARCHITECTURE_ANALYZER_INSTRUCTIONS,
        tools=[
            create_shell_tool(workspace_dir),
            create_file_reader_tool(workspace_dir),
            create_search_tool(workspace_dir),
        ],
        output_type=ArchitectureAnalyzerResult,
    )


def create_pattern_finder_agent(
    model: str = "gpt-4o",
    workspace_dir: str = DEFAULT_CWD,
) -> Agent:
    """Create the pattern finder agent.

    Uses shell tools for pattern discovery and web search for best practices.

    Args:
        model: OpenAI model to use
        workspace_dir: Working directory for shell commands

    Returns:
        Configured Agent instance
    """
    return Agent(
        name="PatternFinder",
        model=model,
        instructions=PATTERN_FINDER_INSTRUCTIONS,
        tools=[
            create_shell_tool(workspace_dir),
            create_file_reader_tool(workspace_dir),
            create_search_tool(workspace_dir),
            WebSearchTool(),
        ],
        output_type=PatternFinderResult,
    )


def create_task_planner_agent(
    model: str = "gpt-4o",
) -> Agent:
    """Create the task planner agent.

    This agent has no tools - it performs pure synthesis from research results.

    Args:
        model: OpenAI model to use

    Returns:
        Configured Agent instance
    """
    return Agent(
        name="TaskPlanner",
        model=model,
        instructions=TASK_PLANNER_INSTRUCTIONS,
        tools=[],  # No tools - pure synthesis
        output_type=TaskPlan,
    )


# ============================================================================
# Agent Configuration
# ============================================================================


class AgentConfig:
    """Configuration for the multi-agent planning system."""

    def __init__(
        self,
        model: str = "gpt-4o",
        workspace_dir: str = DEFAULT_CWD,
        orchestrator_model: Optional[str] = None,
        explorer_model: Optional[str] = None,
        analyzer_model: Optional[str] = None,
        pattern_finder_model: Optional[str] = None,
        task_planner_model: Optional[str] = None,
    ):
        """Initialize agent configuration.

        Args:
            model: Default model for all agents
            workspace_dir: Working directory for shell commands
            orchestrator_model: Override model for orchestrator
            explorer_model: Override model for explorer
            analyzer_model: Override model for analyzer
            pattern_finder_model: Override model for pattern finder
            task_planner_model: Override model for task planner
        """
        self.workspace_dir = workspace_dir
        self.orchestrator_model = orchestrator_model or model
        self.explorer_model = explorer_model or model
        self.analyzer_model = analyzer_model or model
        self.pattern_finder_model = pattern_finder_model or model
        self.task_planner_model = task_planner_model or model

    def create_orchestrator(self) -> Agent:
        """Create orchestrator agent with configured settings."""
        return create_orchestrator_agent(
            model=self.orchestrator_model,
            workspace_dir=self.workspace_dir,
        )

    def create_codebase_explorer(self) -> Agent:
        """Create codebase explorer agent with configured settings."""
        return create_codebase_explorer_agent(
            model=self.explorer_model,
            workspace_dir=self.workspace_dir,
        )

    def create_architecture_analyzer(self) -> Agent:
        """Create architecture analyzer agent with configured settings."""
        return create_architecture_analyzer_agent(
            model=self.analyzer_model,
            workspace_dir=self.workspace_dir,
        )

    def create_pattern_finder(self) -> Agent:
        """Create pattern finder agent with configured settings."""
        return create_pattern_finder_agent(
            model=self.pattern_finder_model,
            workspace_dir=self.workspace_dir,
        )

    def create_task_planner(self) -> Agent:
        """Create task planner agent with configured settings."""
        return create_task_planner_agent(
            model=self.task_planner_model,
        )
