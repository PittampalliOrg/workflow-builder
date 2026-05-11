"""Dapr workflow attribute key constants — centralized for forward-compat
with the Dapr OpenTelemetry Weaver semantic-conventions work (initial PR
landed Jan 2026, tracked in research-the-most-popular-stateful-hinton.md
Phase 1 / Alignment section).

When Dapr Weaver mandates a different naming (e.g. switches
`durabletask.task.instance_id` → `dapr.workflow.instance_id`), update
the constants here in ONE place — every call site reads from this
module.

Today's MLflow trace UI shows `durabletask.*` keys on Dapr-emitted spans
because the orchestrator's daprd sidecar uses durabletask-go's
historical attribute names. We deliberately add `dapr.workflow.*`
mirror tags on OUR application-emitted spans so:

1. Future Dapr Weaver users get the standardized name immediately
2. Existing analytics keyed on `workflow.execution.id` keep working
3. Cross-service queries can target either name
"""

# Our application-emitted attribute names (used today by tracing.py +
# the BFF's observability/workflow-session.ts).
SESSION_ID_ATTRIBUTE = "session.id"
WORKFLOW_EXECUTION_ATTRIBUTE = "workflow.execution.id"
WORKFLOW_ID_ATTRIBUTE = "workflow.id"
WORKFLOW_NAME_ATTRIBUTE = "workflow.name"

# Dapr Weaver-aligned mirror keys. As of the initial Weaver PR these are
# the proposed names — track the upstream PR and update here when the
# spec stabilizes. Listed alongside, never replacing, our app keys.
DAPR_WORKFLOW_INSTANCE_ID = "dapr.workflow.instance_id"
DAPR_WORKFLOW_NAME = "dapr.workflow.name"

# User / org / agent identity (independent of Dapr; kept here for the
# same "one rename, all call sites" property as the Dapr keys).
USER_ID_ATTRIBUTE = "user.id"
ORGANIZATION_ID_ATTRIBUTE = "organization.id"
AGENT_SLUG_ATTRIBUTE = "agent.slug"
AGENT_MODEL_SPEC_ATTRIBUTE = "agent.model_spec"
AGENT_LLM_COMPONENT_ATTRIBUTE = "agent.llm_component"
AGENT_CONFIG_REVISION_ATTRIBUTE = "agent.config_revision"

# Prompt registry (populated once Phase 3a lands).
PROMPT_VERSION_ATTRIBUTE = "prompt_version"


def workflow_trace_tags(
    *,
    session_id: str | None,
    execution_id: str | None = None,
    workflow_id: str | None = None,
    workflow_name: str | None = None,
    user_id: str | None = None,
    organization_id: str | None = None,
    agent_slug: str | None = None,
    agent_model_spec: str | None = None,
    agent_llm_component: str | None = None,
    agent_config_revision: str | None = None,
    prompt_version: str | None = None,
) -> dict[str, str]:
    """Build a curated tag dict for `mlflow.tracing.update_current_trace`.

    Returns ONLY keys whose value is a non-empty string — MLflow rejects
    non-string tag values. The execution_id defaults to session_id when
    not given (orchestrator pattern where they're 1:1).
    """
    exec_id = execution_id or session_id
    tags: dict[str, str] = {}

    def _stash(key: str, value: str | None) -> None:
        if value and isinstance(value, str) and value.strip():
            tags[key] = value.strip()

    _stash(SESSION_ID_ATTRIBUTE, session_id)
    _stash(WORKFLOW_EXECUTION_ATTRIBUTE, exec_id)
    _stash(DAPR_WORKFLOW_INSTANCE_ID, exec_id)
    _stash(WORKFLOW_ID_ATTRIBUTE, workflow_id)
    _stash(WORKFLOW_NAME_ATTRIBUTE, workflow_name)
    _stash(DAPR_WORKFLOW_NAME, workflow_name)
    _stash(USER_ID_ATTRIBUTE, user_id)
    _stash(ORGANIZATION_ID_ATTRIBUTE, organization_id)
    _stash(AGENT_SLUG_ATTRIBUTE, agent_slug)
    _stash(AGENT_MODEL_SPEC_ATTRIBUTE, agent_model_spec)
    _stash(AGENT_LLM_COMPONENT_ATTRIBUTE, agent_llm_component)
    _stash(AGENT_CONFIG_REVISION_ATTRIBUTE, agent_config_revision)
    _stash(PROMPT_VERSION_ATTRIBUTE, prompt_version)

    return tags
