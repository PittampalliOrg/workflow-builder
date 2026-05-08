import json
from types import SimpleNamespace

import src.app as app_module
from src.app import (
    AgentWorkflowHostRequest,
    ExecutionClassConfig,
    ExecutionRequest,
    build_agent_workflow_host_job_manifest,
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


def test_benchmark_fast_job_is_kueue_managed() -> None:
    request = _request()
    manifest = build_job_manifest(
        request,
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(localQueue="benchmark-fast"),
    )
    configmap = build_payload_configmap_manifest(
        request,
        execution_id="hexec-123",
        namespace="sandbox-execution",
    )

    assert manifest["metadata"]["labels"]["kueue.x-k8s.io/queue-name"] == "benchmark-fast"
    assert manifest["spec"]["ttlSecondsAfterFinished"] == 300
    pod_spec = manifest["spec"]["template"]["spec"]
    container = pod_spec["containers"][0]
    assert pod_spec["nodeSelector"] == {"stacks.io/swebench-pool": "dev-benchmark"}
    assert pod_spec["serviceAccountName"] == "sandbox-execution-worker"
    assert pod_spec["imagePullSecrets"] == [{"name": "ghcr-pull-credentials"}]
    assert "runtimeClassName" not in pod_spec
    assert container["image"] == "ghcr.io/pittampalliorg/sandbox-execution-api:latest"
    assert container["command"] == ["python", "-m", "src.worker"]
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


def test_secure_gvisor_sets_runtime_class_and_queue() -> None:
    manifest = build_job_manifest(
        _request("secure-gvisor"),
        execution_id="hexec-123",
        namespace="sandbox-execution",
        class_config=ExecutionClassConfig(
            localQueue="secure-gvisor",
            runtimeClassName="gvisor",
        ),
    )

    assert manifest["metadata"]["labels"]["kueue.x-k8s.io/queue-name"] == "secure-gvisor"
    assert manifest["spec"]["template"]["spec"]["runtimeClassName"] == "gvisor"


def test_agent_workflow_host_job_is_kueue_managed_dapr_native_sidecar() -> None:
    manifest = build_agent_workflow_host_job_manifest(
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

    assert manifest["metadata"]["labels"]["kueue.x-k8s.io/queue-name"] == "benchmark-fast"
    template = manifest["spec"]["template"]
    annotations = template["metadata"]["annotations"]
    assert annotations["dapr.io/app-id"] == "agent-session-abc123"
    assert annotations["dapr.io/config"] == "workflow-builder-agent-runtime"
    assert annotations["dapr.io/enable-workflow"] == "true"
    assert annotations["dapr.io/enable-native-sidecar"] == "true"
    pod_spec = template["spec"]
    assert pod_spec["serviceAccountName"] == "sandbox-execution-worker"
    assert pod_spec["initContainers"][0]["name"] == "seed-openshell-config"
    container = pod_spec["containers"][0]
    assert container["image"] == "ghcr.io/example/dapr-agent-py-sandbox:git-1"
    env = {entry["name"]: entry.get("value") for entry in container["env"]}
    assert env["AGENT_SERVICE_NAME"] == "agent-session-abc123"
    assert env["DAPR_GRPC_ENDPOINT"] == "dns:localhost:50001"
    assert env["DAPR_AGENT_SESSION_HOST_INSTANCE_ID"] == "sw-session-1"
    env_from = container["envFrom"]
    assert env_from[0]["configMapRef"] == {
        "name": "dapr-agent-py-config",
        "optional": True,
    }
    assert container["resources"]["requests"]["cpu"] == "500m"
    assert container["resources"]["requests"]["memory"] == "1Gi"
    assert container["resources"]["requests"]["ephemeral-storage"] == "2Gi"


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


def test_component_scope_patch_leaves_unscoped_component_unmodified(monkeypatch) -> None:
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
