import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import src.app as app_module
from src.app import (
    AgentWorkflowHostRequest,
    ExecutionClassConfig,
    ExecutionRequest,
    build_agent_workflow_host_sandbox_manifest,
    build_job_manifest,
    build_payload_configmap_manifest,
)


def _request(execution_class: str = "benchmark-fast") -> ExecutionRequest:
    return ExecutionRequest(
        runId="run_1",
        instanceId="sympy__sympy-20590",
        workflowId="wf_1",
        workflowExecutionId="exec_1",
        executionClass=execution_class,
        timeoutSeconds=7200,
        workflow={"document": {"dsl": "1.0.0"}},
        triggerData={"runId": "run_1"},
        inferenceEnvironment={"sandboxImage": "ghcr.io/example/image@sha256:1"},
        callback={
            "path": "/api/internal/benchmarks/runs/run_1/instances/sympy__sympy-20590/execution"
        },
    )


def test_benchmark_fast_worker_job_is_kueue_managed() -> None:
    request = _request()
    manifest = build_job_manifest(
        request,
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            priorityClass="swebench-cohort",
            priorityClassName="benchmark-workload",
        ),
    )
    configmap = build_payload_configmap_manifest(
        request,
        execution_id="hexec-123",
        namespace="sandbox-execution",
    )

    assert (
        manifest["metadata"]["labels"]["kueue.x-k8s.io/queue-name"] == "benchmark-fast"
    )
    assert (
        manifest["metadata"]["labels"]["kueue.x-k8s.io/priority-class"]
        == "swebench-cohort"
    )
    assert manifest["spec"]["ttlSecondsAfterFinished"] == 300
    pod_spec = manifest["spec"]["template"]["spec"]
    pod_labels = manifest["spec"]["template"]["metadata"]["labels"]
    container = pod_spec["containers"][0]
    assert pod_labels["kueue.x-k8s.io/queue-name"] == "benchmark-fast"
    assert pod_labels["kueue.x-k8s.io/priority-class"] == "swebench-cohort"
    assert pod_spec["nodeSelector"] == {"stacks.io/swebench-pool": "dev-benchmark"}
    assert pod_spec["serviceAccountName"] == "sandbox-execution-worker"
    assert pod_spec["priorityClassName"] == "benchmark-workload"
    assert pod_spec["imagePullSecrets"] == [{"name": "ghcr-pull-credentials"}]
    assert "runtimeClassName" not in pod_spec
    assert container["image"] == "ghcr.io/pittampalliorg/sandbox-execution-api:latest"
    assert container["command"] == ["python", "-m", "src.worker"]
    assert container["securityContext"] == {
        "allowPrivilegeEscalation": False,
        "capabilities": {"drop": ["ALL"]},
    }
    assert container["resources"]["requests"]["ephemeral-storage"] == "1Gi"
    assert container["env"][0] == {
        "name": "EXECUTION_REQUEST_PATH",
        "value": "/var/run/sandbox-execution/request.json",
    }
    assert "EXECUTION_REQUEST_JSON" not in json.dumps(container["env"])
    assert container["volumeMounts"][0]["name"] == "execution-request"
    assert pod_spec["volumes"][0]["configMap"]["name"] == configmap["metadata"]["name"]
    payload = json.loads(configmap["data"]["request.json"])
    assert payload["runId"] == "run_1"
    assert payload["instanceId"] == "sympy__sympy-20590"


def test_worker_retry_and_throttle_env_is_passed_through(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_WORKFLOW_START_ATTEMPTS", "20")
    monkeypatch.setenv("SANDBOX_EXECUTION_WORKFLOW_START_STAGGER_SECONDS", "180")
    manifest = build_job_manifest(
        _request(),
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )

    env = {
        entry["name"]: entry.get("value")
        for entry in manifest["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert env["SANDBOX_EXECUTION_WORKFLOW_START_ATTEMPTS"] == "20"
    assert env["SANDBOX_EXECUTION_WORKFLOW_START_STAGGER_SECONDS"] == "180"


def test_job_ttl_can_be_overridden_by_class_config() -> None:
    manifest = build_job_manifest(
        _request(),
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            ttlSecondsAfterFinished=120,
        ),
    )

    assert manifest["spec"]["ttlSecondsAfterFinished"] == 120


def test_job_ttl_can_be_overridden_by_env(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_JOB_TTL_SECONDS", "600")
    manifest = build_job_manifest(
        _request(),
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )

    assert manifest["spec"]["ttlSecondsAfterFinished"] == 600


def test_secure_gvisor_sets_runtime_class_and_queue_on_worker_job() -> None:
    manifest = build_job_manifest(
        _request("secure-gvisor"),
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(
            localQueue="secure-gvisor",
            runtimeClassName="gvisor",
            priorityClass="swebench-cohort",
        ),
    )

    assert (
        manifest["metadata"]["labels"]["kueue.x-k8s.io/queue-name"] == "secure-gvisor"
    )
    assert (
        manifest["metadata"]["labels"]["kueue.x-k8s.io/priority-class"]
        == "swebench-cohort"
    )
    assert manifest["spec"]["template"]["spec"]["runtimeClassName"] == "gvisor"


def test_worker_job_priority_label_can_be_overridden_by_request() -> None:
    request = _request()
    request.priorityClass = "interactive-agent"
    manifest = build_job_manifest(
        request,
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            priorityClass="swebench-cohort",
        ),
    )

    assert (
        manifest["metadata"]["labels"]["kueue.x-k8s.io/priority-class"]
        == "interactive-agent"
    )
    assert (
        manifest["spec"]["template"]["metadata"]["labels"][
            "kueue.x-k8s.io/priority-class"
        ]
        == "interactive-agent"
    )


def test_agent_workflow_host_sandbox_is_kueue_managed_dapr_native_sidecar() -> None:
    before = datetime.now(UTC)
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostImage="ghcr.io/example/dapr-agent-py-sandbox:git-1",
            agentHostEnv={
                "DAPR_AGENT_APP_MODULE": "src.minimal_main:app",
                "AGENT_CALL_AGENT_NATIVE": "false",
            },
        ),
    )

    assert manifest["apiVersion"] == "agents.x-k8s.io/v1alpha1"
    assert manifest["kind"] == "Sandbox"
    assert manifest["spec"]["replicas"] == 1
    assert manifest["spec"]["shutdownPolicy"] == "Delete"
    shutdown_time = datetime.fromisoformat(
        manifest["spec"]["shutdownTime"].replace("Z", "+00:00")
    )
    assert before + timedelta(seconds=900 + 1800 - 1) <= shutdown_time
    assert shutdown_time <= datetime.now(UTC) + timedelta(seconds=900 + 1800 + 1)
    # Kueue Plain Pod admission requires the queue label on the podTemplate,
    # not on the parent Sandbox metadata.
    assert "kueue.x-k8s.io/queue-name" not in manifest["metadata"]["labels"]
    pod_template = manifest["spec"]["podTemplate"]
    assert (
        pod_template["metadata"]["labels"]["kueue.x-k8s.io/queue-name"]
        == "benchmark-fast"
    )
    annotations = pod_template["metadata"]["annotations"]
    assert annotations["dapr.io/app-id"] == "agent-session-abc123"
    assert annotations["dapr.io/config"] == "workflow-builder-agent-runtime"
    assert annotations["dapr.io/enable-workflow"] == "true"
    assert annotations["dapr.io/enable-native-sidecar"] == "true"
    assert annotations["dapr.io/internal-grpc-port"] == "3502"
    assert annotations["dapr.io/max-body-size"] == "16Mi"
    assert annotations["prometheus.io/scrape"] == "true"
    assert annotations["prometheus.io/port"] == "9090"
    assert annotations["prometheus.io/path"] == "/"
    assert "kueue.x-k8s.io/priority-class" not in pod_template["metadata"]["labels"]
    pod_spec = pod_template["spec"]
    # Job-only fields must not leak through to the Sandbox.
    assert "backoffLimit" not in manifest["spec"]
    assert "ttlSecondsAfterFinished" not in manifest["spec"]
    # The pod (not the Sandbox) carries the deadline.
    assert pod_spec["activeDeadlineSeconds"] == 900 + 600
    assert pod_spec["serviceAccountName"] == "sandbox-execution-worker"
    assert pod_spec["initContainers"][0]["name"] == "seed-openshell-config"
    assert pod_spec["initContainers"][0]["imagePullPolicy"] == "IfNotPresent"
    assert pod_spec["initContainers"][0]["securityContext"] == {
        "allowPrivilegeEscalation": False,
        "capabilities": {"drop": ["ALL"]},
    }
    container = pod_spec["containers"][0]
    assert container["image"] == "ghcr.io/example/dapr-agent-py-sandbox:git-1"
    assert container["imagePullPolicy"] == "IfNotPresent"
    assert container["securityContext"] == {
        "allowPrivilegeEscalation": False,
        "capabilities": {"drop": ["ALL"]},
    }
    env = {entry["name"]: entry.get("value") for entry in container["env"]}
    assert env["AGENT_SERVICE_NAME"] == "agent-session-abc123"
    assert env["DAPR_GRPC_ENDPOINT"] == "dns:localhost:50001"
    assert env["DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES"] == "16777216"
    assert env["DAPR_WORKFLOW_MAX_CONCURRENT_ORCHESTRATIONS"] == "16"
    assert env["DAPR_WORKFLOW_MAX_CONCURRENT_ACTIVITIES"] == "48"
    assert env["DAPR_AGENT_PY_HOOKS_ENABLED"] == "false"
    assert env["DAPR_AGENT_PY_PLUGINS_ENABLED"] == "false"
    assert env["DAPR_AGENT_SESSION_HOST_INSTANCE_ID"] == "sw-session-1"
    assert env["DAPR_AGENT_SESSION_HOST_BENCHMARK_RUN_ID"] == "run_1"
    assert env["DAPR_AGENT_SESSION_HOST_BENCHMARK_INSTANCE_ID"] == "sympy__sympy-20590"
    assert env["DAPR_AGENT_SESSION_HOST_START_TIMEOUT_SECONDS"] == "900"
    assert env["DAPR_AGENT_SESSION_HOST_MISSING_GRACE_SECONDS"] == "60"
    assert env["DAPR_AGENT_SESSION_HOST_SIDECAR_READY_TIMEOUT_SECONDS"] == "120"
    assert env["DAPR_AGENT_SESSION_HOST_SHUTDOWN_SIDECAR_ON_EXIT"] == "true"
    assert env["DAPR_AGENT_SESSION_HOST_TERMINAL_HOLD_SECONDS"] == "0"
    assert env["DAPR_AGENT_SESSION_HOST_NONTERMINAL_TIMEOUT_ACTION"] == "warn"
    assert env["AGENT_CALL_AGENT_NATIVE"] == "false"
    assert env["DAPR_AGENT_APP_MODULE"] == "src.minimal_main:app"
    env_from = container["envFrom"]
    assert {
        "configMapRef": {
            "name": "dapr-agent-py-config",
            "optional": True,
        }
    } in env_from
    assert {
        "configMapRef": {
            "name": "adk-agent-py-config",
            "optional": True,
        }
    } not in env_from
    assert container["resources"]["requests"]["cpu"] == "500m"
    assert container["resources"]["requests"]["memory"] == "1Gi"
    assert container["resources"]["requests"]["ephemeral-storage"] == "2Gi"
    assert container["resources"]["limits"]["memory"] == "1Gi"
    assert container["resources"]["limits"]["ephemeral-storage"] == "2Gi"
    assert "cpu" not in container["resources"]["limits"]


def test_agent_workflow_host_can_prefix_pubsub_topics(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_AGENT_TOPIC_PREFIX", "wbpreview-codex-nats")

    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostImage="ghcr.io/example/dapr-agent-py-sandbox:git-1",
        ),
    )

    env = {
        entry["name"]: entry.get("value")
        for entry in manifest["spec"]["podTemplate"]["spec"]["containers"][0]["env"]
    }
    assert env["AGENT_SERVICE_NAME"] == "agent-session-abc123"
    assert env["AGENT_TOPIC"] == "wbpreview-codex-nats.agent-session-abc123.requests"
    assert (
        env["AGENT_BROADCAST_TOPIC"]
        == "wbpreview-codex-nats.agent-session-abc123.broadcast"
    )


def test_agent_workflow_host_sandbox_can_override_resource_limits() -> None:
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostCpu="500m",
            agentHostMemory="1Gi",
            agentHostEphemeralStorage="2Gi",
            agentHostCpuLimit="1500m",
            agentHostMemoryLimit="2Gi",
            agentHostEphemeralStorageLimit="4Gi",
        ),
    )

    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    assert container["resources"]["requests"]["cpu"] == "500m"
    assert container["resources"]["requests"]["memory"] == "1Gi"
    assert container["resources"]["requests"]["ephemeral-storage"] == "2Gi"
    assert container["resources"]["limits"]["cpu"] == "1500m"
    assert container["resources"]["limits"]["memory"] == "2Gi"
    assert container["resources"]["limits"]["ephemeral-storage"] == "4Gi"


def test_agent_workflow_host_sandbox_uses_adk_config_only_for_adk_image() -> None:
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            agentImage="ghcr.io/example/adk-agent-py-sandbox:git-1",
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )

    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    assert container["image"] == "ghcr.io/example/adk-agent-py-sandbox:git-1"
    env_from = container["envFrom"]
    assert {
        "configMapRef": {
            "name": "dapr-agent-py-config",
            "optional": True,
        }
    } in env_from
    assert {
        "configMapRef": {
            "name": "adk-agent-py-config",
            "optional": True,
        }
    } in env_from


def test_agent_workflow_host_sandbox_uses_claude_config_only_for_claude_image() -> None:
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            agentImage="ghcr.io/example/claude-agent-py-sandbox:git-1",
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )

    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    assert container["image"] == "ghcr.io/example/claude-agent-py-sandbox:git-1"
    env_from = container["envFrom"]
    assert {
        "configMapRef": {
            "name": "dapr-agent-py-config",
            "optional": True,
        }
    } in env_from
    assert {
        "configMapRef": {
            "name": "claude-agent-py-config",
            "optional": True,
        }
    } in env_from
    assert {
        "configMapRef": {
            "name": "adk-agent-py-config",
            "optional": True,
        }
    } not in env_from


def test_agent_workflow_host_sandbox_uses_class_nonterminal_timeout_action() -> None:
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostNonterminalTimeoutAction="terminate",
        ),
    )

    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    env = {entry["name"]: entry.get("value") for entry in container["env"]}
    assert env["DAPR_AGENT_SESSION_HOST_NONTERMINAL_TIMEOUT_ACTION"] == "terminate"


def test_agent_workflow_host_sandbox_without_timeout_has_no_active_deadline(
    monkeypatch,
) -> None:
    monkeypatch.delenv("DAPR_AGENT_SESSION_HOST_START_TIMEOUT_SECONDS", raising=False)
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostImage="ghcr.io/example/dapr-agent-py-sandbox:git-1",
        ),
    )

    pod_spec = manifest["spec"]["podTemplate"]["spec"]
    assert "activeDeadlineSeconds" not in pod_spec
    assert "shutdownPolicy" not in manifest["spec"]
    assert "shutdownTime" not in manifest["spec"]
    container = pod_spec["containers"][0]
    env = {entry["name"]: entry.get("value") for entry in container["env"]}
    assert env["DAPR_AGENT_SESSION_HOST_START_TIMEOUT_SECONDS"] == "900"


def test_agent_workflow_host_sandbox_shutdown_buffer_can_be_tuned(
    monkeypatch,
) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_AGENT_HOST_SHUTDOWN_BUFFER_SECONDS", "60")
    before = datetime.now(UTC)

    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostImage="ghcr.io/example/dapr-agent-py-sandbox:git-1",
        ),
    )

    shutdown_time = datetime.fromisoformat(
        manifest["spec"]["shutdownTime"].replace("Z", "+00:00")
    )
    assert before + timedelta(seconds=900 + 60 - 1) <= shutdown_time
    assert shutdown_time <= datetime.now(UTC) + timedelta(seconds=900 + 60 + 1)


def test_agent_workflow_host_sandbox_stamps_traceparent_via_downward_api() -> None:
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostImage="ghcr.io/example/dapr-agent-py-sandbox:git-1",
        ),
        trace_context={
            "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            "tracestate": "rojo=00f067aa0ba902b7",
            "baggage": "workflow.execution.id=exec_1,session.id=session_1",
        },
    )

    sandbox_annotations = manifest["metadata"].get("annotations", {})
    assert (
        sandbox_annotations["workflow-builder.cnoe.io/traceparent"]
        == "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
    )
    assert (
        sandbox_annotations["workflow-builder.cnoe.io/tracestate"]
        == "rojo=00f067aa0ba902b7"
    )
    assert (
        sandbox_annotations["workflow-builder.cnoe.io/baggage"]
        == "workflow.execution.id=exec_1,session.id=session_1"
    )
    pod_template_annotations = manifest["spec"]["podTemplate"]["metadata"][
        "annotations"
    ]
    # The downward-API fieldRef reads the *pod*'s annotations, not the parent
    # Sandbox's metadata.annotations, so the trace-context must also be stamped
    # on the pod template for the env var to resolve.
    assert (
        pod_template_annotations["workflow-builder.cnoe.io/traceparent"]
        == "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
    )
    assert (
        pod_template_annotations["workflow-builder.cnoe.io/tracestate"]
        == "rojo=00f067aa0ba902b7"
    )
    assert (
        pod_template_annotations["workflow-builder.cnoe.io/baggage"]
        == "workflow.execution.id=exec_1,session.id=session_1"
    )
    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    env_by_name = {e["name"]: e for e in container["env"]}
    assert "WORKFLOW_BUILDER_TRACEPARENT" in env_by_name
    assert "WORKFLOW_BUILDER_BAGGAGE" in env_by_name
    field_ref = env_by_name["WORKFLOW_BUILDER_TRACEPARENT"]["valueFrom"]["fieldRef"]
    assert field_ref["fieldPath"] == (
        "metadata.annotations['workflow-builder.cnoe.io/traceparent']"
    )
    baggage_ref = env_by_name["WORKFLOW_BUILDER_BAGGAGE"]["valueFrom"]["fieldRef"]
    assert baggage_ref["fieldPath"] == (
        "metadata.annotations['workflow-builder.cnoe.io/baggage']"
    )


def test_agent_workflow_host_sandbox_propagates_capacity_owner_labels() -> None:
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="SW_SESSION_Mixed",
            agentAppId="agent-session-abc123",
            runId="Run_Mixed/1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostImage="ghcr.io/example/dapr-agent-py-sandbox:git-1",
        ),
    )

    owner_labels = {
        "benchmark-run-id": "run-mixed-1",
        "benchmark-instance-id": "sympy-sympy-20590",
        "agent-app-id": "agent-session-abc123",
        "workflow-builder.cnoe.io/session-id": "sw-session-mixed",
    }
    assert (
        manifest["metadata"]["labels"] | owner_labels == manifest["metadata"]["labels"]
    )
    pod_labels = manifest["spec"]["podTemplate"]["metadata"]["labels"]
    assert pod_labels | owner_labels == pod_labels


def test_agent_workflow_host_sandbox_omits_trace_annotations_when_unset() -> None:
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostImage="ghcr.io/example/dapr-agent-py-sandbox:git-1",
        ),
    )

    # No trace context -> no trace annotations are stamped, so the downward-API
    # env stays empty rather than blocking the pod from starting. The Sandbox CR
    # still always carries the owner-run-id annotation (used by the create-409
    # adopt-same-run-vs-recreate check), and nothing else.
    annotations = manifest["metadata"].get("annotations", {})
    assert "workflow-builder.cnoe.io/traceparent" not in annotations
    assert "workflow-builder.cnoe.io/tracestate" not in annotations
    assert "workflow-builder.cnoe.io/baggage" not in annotations
    assert (
        annotations["agents.workflow-builder.cnoe.io/owner-run-id"]
        == "sw-session-1|run_1"
    )


def test_agent_workflow_host_sandbox_stamps_kueue_priority_class() -> None:
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
            priorityClass="interactive-agent",
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostImage="ghcr.io/example/dapr-agent-py-sandbox:git-1",
        ),
    )

    pod_labels = manifest["spec"]["podTemplate"]["metadata"]["labels"]
    assert pod_labels["kueue.x-k8s.io/priority-class"] == "interactive-agent"
    assert pod_labels["kueue.x-k8s.io/queue-name"] == "benchmark-fast"


def test_agent_workflow_host_sandbox_always_pulls_mutable_latest_images() -> None:
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostImage="ghcr.io/example/dapr-agent-py-sandbox:latest",
        ),
    )

    pod_spec = manifest["spec"]["podTemplate"]["spec"]
    assert pod_spec["initContainers"][0]["imagePullPolicy"] == "Always"
    assert pod_spec["containers"][0]["imagePullPolicy"] == "Always"


def test_agent_workflow_host_sandbox_caches_digest_images() -> None:
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="benchmark-fast",
            agentHostImage="ghcr.io/example/dapr-agent-py-sandbox@sha256:"
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
    )

    pod_spec = manifest["spec"]["podTemplate"]["spec"]
    assert pod_spec["initContainers"][0]["imagePullPolicy"] == "IfNotPresent"
    assert pod_spec["containers"][0]["imagePullPolicy"] == "IfNotPresent"


class _FakeCustom:
    def __init__(self) -> None:
        self.creates: list[tuple[str, str, str, str, dict]] = []

    def create_namespaced_custom_object(
        self, *, group, version, namespace, plural, body
    ):
        self.creates.append((group, version, namespace, plural, body))
        return body


def test_submit_agent_workflow_host_defaults_to_workflow_builder_namespace(
    monkeypatch,
) -> None:
    fake_custom = _FakeCustom()
    fake_core = SimpleNamespace()
    scoped_components: list[tuple[str, str]] = []
    readiness_checks: list[tuple[str, str]] = []

    monkeypatch.setenv("SANDBOX_EXECUTION_NAMESPACE", "openshell")
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.delenv("AGENT_WORKFLOW_HOST_NAMESPACE", raising=False)
    monkeypatch.delenv("WORKFLOW_BUILDER_NAMESPACE", raising=False)
    monkeypatch.setattr(
        app_module,
        "_load_execution_classes",
        lambda: {"benchmark-fast": ExecutionClassConfig(localQueue="benchmark-fast")},
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (SimpleNamespace(), fake_core)
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: fake_custom
    )
    monkeypatch.setattr(
        app_module,
        "_ensure_agent_host_component_scopes",
        lambda namespace, app_id: scoped_components.append((namespace, app_id)),
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_agent_host_ready",
        lambda _core, *, namespace, agent_app_id, **_kwargs: (
            readiness_checks.append((namespace, agent_app_id)) or "ready"
        ),
    )

    response = app_module.submit_agent_workflow_host(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
        ),
    )

    assert response["status"] == "ready"
    assert response["sandboxName"]
    assert response["sandboxName"] == response["jobName"]
    assert len(fake_custom.creates) == 1
    group, version, namespace, plural, body = fake_custom.creates[0]
    assert (group, version, plural) == ("agents.x-k8s.io", "v1alpha1", "sandboxes")
    assert namespace == "workflow-builder"
    assert body["metadata"]["namespace"] == "workflow-builder"
    assert body["kind"] == "Sandbox"
    assert scoped_components == [("workflow-builder", "agent-session-abc123")]
    assert readiness_checks == [("workflow-builder", "agent-session-abc123")]


def test_submit_agent_workflow_host_allows_explicit_namespace(monkeypatch) -> None:
    fake_custom = _FakeCustom()

    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setenv("SANDBOX_EXECUTION_NAMESPACE", "openshell")
    monkeypatch.setenv("AGENT_WORKFLOW_HOST_NAMESPACE", "workflow-builder-canary")
    monkeypatch.setattr(
        app_module,
        "_load_execution_classes",
        lambda: {"benchmark-fast": ExecutionClassConfig(localQueue="benchmark-fast")},
    )
    monkeypatch.setattr(
        app_module,
        "_load_k8s_clients",
        lambda: (SimpleNamespace(), SimpleNamespace()),
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: fake_custom
    )
    monkeypatch.setattr(
        app_module,
        "_ensure_agent_host_component_scopes",
        lambda _namespace, _app_id: None,
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_agent_host_ready",
        lambda *_args, **_kwargs: "queued",
    )

    response = app_module.submit_agent_workflow_host(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            instanceId="sympy__sympy-20590",
            executionClass="benchmark-fast",
            timeoutSeconds=900,
        ),
    )

    assert response["status"] == "queued"
    assert len(fake_custom.creates) == 1
    assert fake_custom.creates[0][2] == "workflow-builder-canary"


def test_component_scope_patch_uses_json_patch_append(monkeypatch) -> None:
    class FakeCustom:
        def __init__(self) -> None:
            self.component = {"scopes": ["workflow-orchestrator"]}
            self.api_client = self
            self.patches: list[tuple[list[dict[str, str]], dict[str, str]]] = []

        def get_namespaced_custom_object(self, **_kwargs):
            return self.component

        def call_api(
            self,
            _path,
            _method,
            _path_params,
            _query_params,
            header_params,
            *,
            body,
            **_kwargs,
        ):
            self.patches.append((body, header_params))
            assert body == [
                {"op": "add", "path": "/scopes/-", "value": "agent-session-abc123"}
            ]
            assert header_params["Content-Type"] == "application/json-patch+json"
            self.component["scopes"].append(body[0]["value"])

    fake = FakeCustom()
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", lambda: fake)

    app_module._patch_component_scope(
        "workflow-builder",
        "workflowstatestore",
        "agent-session-abc123",
    )

    assert fake.component["scopes"] == [
        "workflow-orchestrator",
        "agent-session-abc123",
    ]
    assert len(fake.patches) == 1


def test_component_scope_patch_leaves_unscoped_component_unmodified(
    monkeypatch,
) -> None:
    class FakeCustom:
        def get_namespaced_custom_object(self, **_kwargs):
            return {}

        def patch_namespaced_custom_object(self, **_kwargs):
            raise AssertionError("unscoped components are already visible to the app")

    monkeypatch.setattr(
        app_module,
        "_load_k8s_custom_objects_client",
        lambda: FakeCustom(),
    )

    app_module._patch_component_scope(
        "workflow-builder",
        "workflowstatestore",
        "agent-session-abc123",
    )


def test_wait_for_agent_host_ready_requires_pod_ready_condition() -> None:
    ready_pod = SimpleNamespace(
        status=SimpleNamespace(
            phase="Running",
            conditions=[SimpleNamespace(type="Ready", status="True")],
            container_statuses=[],
        )
    )
    core = SimpleNamespace(
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(items=[ready_pod])
    )

    status = app_module._wait_for_agent_host_ready(
        core,
        namespace="workflow-builder",
        agent_app_id="agent-session-abc123",
        wait_seconds=1,
    )

    assert status == "ready"


def test_wait_for_agent_host_ready_returns_queued_when_kueue_delays_pod() -> None:
    pending_pod = SimpleNamespace(
        status=SimpleNamespace(
            phase="Pending",
            conditions=[],
            container_statuses=[],
        )
    )
    core = SimpleNamespace(
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(items=[pending_pod])
    )

    status = app_module._wait_for_agent_host_ready(
        core,
        namespace="workflow-builder",
        agent_app_id="agent-session-abc123",
        wait_seconds=1,
    )

    assert status == "queued"


def test_wait_for_agent_host_ready_allows_sandbox_retry_after_pod_startup_error(
    monkeypatch,
) -> None:
    failed_pod = SimpleNamespace(
        status=SimpleNamespace(
            phase="Running",
            conditions=[],
            container_statuses=[
                SimpleNamespace(
                    state=SimpleNamespace(
                        waiting=SimpleNamespace(
                            reason="CrashLoopBackOff",
                            message="back-off restarting failed container",
                        ),
                        terminated=None,
                    )
                )
            ],
        )
    )
    ready_pod = SimpleNamespace(
        status=SimpleNamespace(
            phase="Running",
            conditions=[SimpleNamespace(type="Ready", status="True")],
            container_statuses=[],
        )
    )
    pod_lists = [[failed_pod], [ready_pod]]

    def list_namespaced_pod(**_kwargs):
        if pod_lists:
            return SimpleNamespace(items=pod_lists.pop(0))
        return SimpleNamespace(items=[ready_pod])

    core = SimpleNamespace(list_namespaced_pod=list_namespaced_pod)
    monkeypatch.setattr(app_module.time, "sleep", lambda _seconds: None)

    status = app_module._wait_for_agent_host_ready(
        core,
        namespace="workflow-builder",
        agent_app_id="agent-session-abc123",
        wait_seconds=1,
        failure_probe=lambda: None,
    )

    assert status == "ready"


def test_wait_for_agent_host_ready_fails_on_terminal_pod_failure() -> None:
    failed_pod = SimpleNamespace(
        status=SimpleNamespace(
            phase="Failed",
            reason="Error",
            conditions=[],
            container_statuses=[],
        )
    )
    core = SimpleNamespace(
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(items=[failed_pod])
    )

    with pytest.raises(HTTPException) as excinfo:
        app_module._wait_for_agent_host_ready(
            core,
            namespace="workflow-builder",
            agent_app_id="agent-session-abc123",
            wait_seconds=1,
        )

    assert excinfo.value.status_code == 503
    assert "Error" in str(excinfo.value.detail)


def test_wait_for_agent_host_ready_fails_on_unrecovered_startup_error(
    monkeypatch,
) -> None:
    failed_pod = SimpleNamespace(
        status=SimpleNamespace(
            phase="Running",
            conditions=[],
            container_statuses=[
                SimpleNamespace(
                    state=SimpleNamespace(
                        waiting=SimpleNamespace(
                            reason="CrashLoopBackOff",
                            message="back-off restarting failed container",
                        ),
                        terminated=None,
                    )
                )
            ],
        )
    )
    core = SimpleNamespace(
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(items=[failed_pod])
    )
    ticks = iter([0.0, 0.0, 2.0])
    monkeypatch.setattr(app_module.time, "monotonic", lambda: next(ticks, 2.0))
    monkeypatch.setattr(app_module.time, "sleep", lambda _seconds: None)

    with pytest.raises(HTTPException) as excinfo:
        app_module._wait_for_agent_host_ready(
            core,
            namespace="workflow-builder",
            agent_app_id="agent-session-abc123",
            wait_seconds=1,
        )

    assert excinfo.value.status_code == 503
    assert "CrashLoopBackOff" in str(excinfo.value.detail)


def test_wait_for_agent_host_ready_fails_when_sandbox_fails() -> None:
    failed_pod = SimpleNamespace(
        status=SimpleNamespace(
            phase="Failed",
            reason="Error",
            conditions=[],
            container_statuses=[],
        )
    )
    core = SimpleNamespace(
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(items=[failed_pod])
    )

    with pytest.raises(HTTPException) as excinfo:
        app_module._wait_for_agent_host_ready(
            core,
            namespace="workflow-builder",
            agent_app_id="agent-session-abc123",
            wait_seconds=1,
            failure_probe=lambda: "AdmissionFailed: cluster queue rejected",
        )

    assert excinfo.value.status_code == 503
    assert "AdmissionFailed" in str(excinfo.value.detail)


def test_sandbox_failure_reason_reads_status_conditions() -> None:
    fake_custom = SimpleNamespace(
        get_namespaced_custom_object=lambda **_kwargs: {
            "status": {
                "conditions": [
                    {
                        "type": "Failed",
                        "status": "True",
                        "reason": "PodFailed",
                        "message": "container exited 1",
                    }
                ]
            }
        }
    )

    reason = app_module._sandbox_failure_reason(
        fake_custom,
        namespace="workflow-builder",
        sandbox_name="agent-host-agent-session-abc123",
    )
    assert reason == "PodFailed: container exited 1"


def test_sandbox_failure_reason_returns_none_when_no_failed_condition() -> None:
    fake_custom = SimpleNamespace(
        get_namespaced_custom_object=lambda **_kwargs: {
            "status": {"conditions": [{"type": "Ready", "status": "True"}]}
        }
    )
    assert (
        app_module._sandbox_failure_reason(
            fake_custom,
            namespace="workflow-builder",
            sandbox_name="agent-host-agent-session-abc123",
        )
        is None
    )


def test_long_resource_names_keep_unique_suffixes() -> None:
    first = _request()
    first.instanceId = "scikit-learn__scikit-learn-10908"
    second = _request()
    second.instanceId = "scikit-learn__scikit-learn-13496"

    first_job = build_job_manifest(
        first,
        execution_id="hexec-d699a",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )
    second_job = build_job_manifest(
        second,
        execution_id="hexec-80977",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )
    first_configmap = build_payload_configmap_manifest(
        first,
        execution_id="hexec-d699a",
        namespace="sandbox-execution",
    )
    second_configmap = build_payload_configmap_manifest(
        second,
        execution_id="hexec-80977",
        namespace="sandbox-execution",
    )

    assert first_job["metadata"]["name"] != second_job["metadata"]["name"]
    assert first_configmap["metadata"]["name"] != second_configmap["metadata"]["name"]
    assert len(first_job["metadata"]["name"]) <= 63
    assert len(second_job["metadata"]["name"]) <= 63
    assert len(first_configmap["metadata"]["name"]) <= 63
    assert len(second_configmap["metadata"]["name"]) <= 63


# ---------------------------------------------------------------------------
# File-first execution classes (preview image freshness Phase 0): the git-synced
# classes.json (SANDBOX_EXECUTION_CLASSES_FILE) wins over SANDBOX_EXECUTION_CLASSES_JSON,
# and a missing/invalid file falls back to the env JSON (then defaults). Merge-over-
# defaults semantics are unchanged regardless of the source.
# ---------------------------------------------------------------------------


def test_execution_classes_file_wins_over_env(tmp_path, monkeypatch) -> None:
    path = tmp_path / "classes.json"
    path.write_text(json.dumps({"benchmark-fast": {"cpu": "111m"}}))
    monkeypatch.setenv("SANDBOX_EXECUTION_CLASSES_FILE", str(path))
    monkeypatch.setenv(
        "SANDBOX_EXECUTION_CLASSES_JSON",
        json.dumps({"benchmark-fast": {"cpu": "222m"}}),
    )
    classes = app_module._load_execution_classes()
    assert classes["benchmark-fast"].cpu == "111m"  # file wins over env
    assert "secure-gvisor" in classes  # merge-over-defaults preserved


def test_execution_classes_bad_file_falls_back_to_env(tmp_path, monkeypatch) -> None:
    path = tmp_path / "classes.json"
    path.write_text("{ this is not json")
    monkeypatch.setenv("SANDBOX_EXECUTION_CLASSES_FILE", str(path))
    monkeypatch.setenv(
        "SANDBOX_EXECUTION_CLASSES_JSON",
        json.dumps({"benchmark-fast": {"cpu": "333m"}}),
    )
    classes = app_module._load_execution_classes()
    assert classes["benchmark-fast"].cpu == "333m"  # invalid file → env fallback


def test_execution_classes_missing_file_falls_back_to_env(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_CLASSES_FILE", str(tmp_path / "absent.json"))
    monkeypatch.setenv(
        "SANDBOX_EXECUTION_CLASSES_JSON",
        json.dumps({"benchmark-fast": {"cpu": "444m"}}),
    )
    assert app_module._load_execution_classes()["benchmark-fast"].cpu == "444m"


def test_execution_classes_no_sources_returns_defaults(monkeypatch) -> None:
    monkeypatch.delenv("SANDBOX_EXECUTION_CLASSES_FILE", raising=False)
    monkeypatch.delenv("SANDBOX_EXECUTION_CLASSES_JSON", raising=False)
    classes = app_module._load_execution_classes()
    assert set(classes) == {"benchmark-fast", "secure-gvisor"}


def test_execution_classes_file_merges_over_defaults(tmp_path, monkeypatch) -> None:
    path = tmp_path / "classes.json"
    path.write_text(
        json.dumps({"dev-preview": {"localQueue": "", "serviceImage": "img:v9"}})
    )
    monkeypatch.setenv("SANDBOX_EXECUTION_CLASSES_FILE", str(path))
    monkeypatch.delenv("SANDBOX_EXECUTION_CLASSES_JSON", raising=False)
    classes = app_module._load_execution_classes()
    assert classes["dev-preview"].serviceImage == "img:v9"
    assert classes["benchmark-fast"].localQueue == "benchmark-fast"  # default kept
