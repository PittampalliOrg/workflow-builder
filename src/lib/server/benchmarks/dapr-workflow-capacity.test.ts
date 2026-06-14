import { afterEach, describe, expect, it } from "vitest";
import { __daprWorkflowCapacityForTest } from "./dapr-workflow-capacity";

describe("Dapr workflow capacity diagnostics", () => {
	afterEach(() => {
		delete process.env.BENCHMARK_DAPR_LOG_WINDOW_SECONDS;
		delete process.env.BENCHMARK_AGENT_HOST_STARTUP_GRACE_SECONDS;
		delete process.env.BENCHMARK_DAPR_STALE_WORKFLOW_EVENT_PRESSURE_THRESHOLD;
	});

	it("does not count normal actor placement logs as runtime pressure", () => {
		const counts = __daprWorkflowCapacityForTest.countLogMatches(
			[
				'time="2026-05-23T11:47:26Z" level=info msg="Dissemination complete for version 75, unlocking disseminator workflow-builder/workflow-orchestrator" scope=dapr.runtime.actors.placement.loops.disseminator',
				'time="2026-05-23T11:51:39Z" level=info msg="Scheduler stream connected for [JOB_TARGET_TYPE_JOB JOB_TARGET_TYPE_ACTOR_REMINDER]" scope=dapr.runtime.scheduler.cluster',
			].join("\n"),
		);

		expect(counts).toEqual({
			actorErrors: 0,
			reminderErrors: 0,
			staleWorkflowEvents: 0,
		});
	});

	it("counts actor and reminder error lines", () => {
		const counts = __daprWorkflowCapacityForTest.countLogMatches(
			[
				'time="2026-05-23T11:57:00Z" level=error msg="actor reminder failed: no such instance exists"',
				'time="2026-05-23T11:57:01Z" level=warn msg="actor lock timeout while processing workflow"',
			].join("\n"),
		);

		expect(counts).toEqual({
			actorErrors: 2,
			reminderErrors: 1,
			staleWorkflowEvents: 0,
		});
	});

	it("does not count scheduler stream shutdown noise from planned restarts", () => {
		const counts = __daprWorkflowCapacityForTest.countLogMatches(
			[
				'time="2026-05-24T15:34:08Z" level=error msg="Scheduler stream disconnected: rpc error: code = Unknown desc = server is closing" scope=dapr.runtime.scheduler.cluster',
				'time="2026-05-24T15:34:12Z" level=error msg="Scheduler stream disconnected: rpc error: code = Canceled desc = grpc: the client connection is closing" scope=dapr.runtime.scheduler.cluster',
			].join("\n"),
		);

		expect(counts).toEqual({
			actorErrors: 0,
			reminderErrors: 0,
			staleWorkflowEvents: 0,
		});
	});

	it("does not count Dapr actor-store hot-reload refusals as runtime pressure", () => {
		const counts = __daprWorkflowCapacityForTest.countLogMatches(
			[
				'time="2026-06-14T06:41:10Z" level=error msg="Aborting to hot-reload a state store component that is used as an actor state store: statestore (state.postgresql/v2)" app_id=workflow-orchestrator scope=dapr.runtime.hotreload.reconciler ver=1.18.0',
			].join("\n"),
		);

		expect(counts).toEqual({
			actorErrors: 0,
			reminderErrors: 0,
			staleWorkflowEvents: 0,
		});
	});

	it("does not count recoverable actor churn while newly-created session hosts join placement", () => {
		const counts = __daprWorkflowCapacityForTest.countLogMatches(
			[
				'time="2026-05-24T21:54:21Z" level=error msg="Timed out waiting for actor in-flight lock claims to be released, force cancelling remaining claims" scope=dapr.runtime.actors.loops.disseminator.inflight.lock',
				`time="2026-05-24T21:54:21Z" level=warning msg="Workflow actor 'sw-swebench-instance-exec-abc': execution failed with a recoverable error and will be retried later: 'failed to invoke 'CreateWorkflowInstance' on remote app 'agent-session-abc' (the app may not be available): context canceled'" scope=dapr.runtime.actors.targets.orchestrator`,
			].join("\n"),
		);

		expect(counts).toEqual({
			actorErrors: 0,
			reminderErrors: 0,
			staleWorkflowEvents: 0,
		});
	});

	it("counts recoverable actor churn on active agent hosts when strict scanning is requested", () => {
		const counts = __daprWorkflowCapacityForTest.countLogMatches(
			[
				'time="2026-05-24T22:43:14Z" level=error msg="Timed out waiting for actor in-flight lock claims to be released, force cancelling remaining claims" scope=dapr.runtime.actors.loops.disseminator.inflight.lock',
				`time="2026-05-24T22:43:14Z" level=warning msg="Workflow actor 'sw-swebench-instance-exec-abc__durable__solve__run__0': execution failed with a recoverable error and will be retried later: 'failed to invoke activity actor 'sw-swebench-instance-exec-abc__durable__solve__run__0::30::1' to execute 'dapr.agents.agent-session-abc.call_llm': context canceled'" scope=dapr.runtime.actors.targets.orchestrator`,
			].join("\n"),
			{
				ignoreActorLockTimeouts: false,
				ignoreRecoverableActorChurn: false,
			},
		);

		expect(counts).toEqual({
			actorErrors: 2,
			reminderErrors: 0,
			staleWorkflowEvents: 0,
		});
	});

	it("does not count expected post-cancel workflow purge chatter as runtime pressure", () => {
		const counts = __daprWorkflowCapacityForTest.countLogMatches(
			[
				`time="2026-05-24T22:22:40Z" level=error msg="orchestration-processor: failed to process work item: failed to submit termination request to sub-orchestration: rpc error: code = Internal desc = error invoke actor method: no such instance exists" scope=dapr.wfengine.durabletask.backend`,
				`time="2026-05-24T22:22:40Z" level=error msg="Workflow actor 'sw-swebench-instance-exec-abc__durable__solve__run__0': cannot add event to workflow as state has been purged. Ignoring event." scope=dapr.runtime.actors.targets.orchestrator`,
				`time="2026-05-24T22:22:40Z" level=warning msg="Workflow actor 'sw-swebench-instance-exec-abc': execution failed with a recoverable error and will be retried later: 'execution aborted'" scope=dapr.runtime.actors.targets.orchestrator`,
				`time="2026-05-24T22:22:40Z" level=warning msg="sw-swebench-instance-exec-abc: aborting workflow execution" scope=dapr.wfengine.backend.actors`,
				`time="2026-05-24T22:22:40Z" level=error msg="failed to invoke scheduled actor reminder named: new-event-et-123 due to: rpc error: code = Unknown desc = execution aborted" scope=dapr.runtime.scheduler.cluster`,
				`time="2026-05-25T00:01:07Z" level=warning msg="Error processing operation DaprBuiltInActorNotFoundRetries. Retrying in 1s..." scope=dapr.runtime`,
				`time="2026-05-25T00:01:08Z" level=warning msg="No workflow state found for actor 'sw-swebench-instance-exec-abc', terminating execution" scope=dapr.runtime.actors.targets.orchestrator`,
				`time="2026-05-25T00:04:38Z" level=error msg="Unable to get data on the instance: sw-swebench-instance-exec-abc, no such instance exists" scope=dapr.wfengine.durabletask.backend`,
				`time="2026-05-25T00:01:07Z" level=error msg="failed to invoke scheduled actor reminder named: new-event-et-123 due to: rpc error: code = Canceled desc = context canceled" scope=dapr.runtime.scheduler.cluster`,
				`time="2026-05-26T13:28:49Z" level=warning msg="Unable to purge the instance: 'sw-swebench-instance-exec-abc', no such instance exists" scope=dapr.wfengine.durabletask.backend`,
			].join("\n"),
		);

		expect(counts).toEqual({
			actorErrors: 0,
			reminderErrors: 0,
			staleWorkflowEvents: 6,
		});
	});

	it("uses a threshold before treating stale workflow event churn as pressure", () => {
		expect(
			__daprWorkflowCapacityForTest.staleWorkflowEventPressureThreshold(),
		).toBe(25);

		process.env.BENCHMARK_DAPR_STALE_WORKFLOW_EVENT_PRESSURE_THRESHOLD = "3";
		expect(
			__daprWorkflowCapacityForTest.staleWorkflowEventPressureThreshold(),
		).toBe(3);
	});

	it("counts workflow start-pending timeouts from parent app logs", () => {
		const count =
			__daprWorkflowCapacityForTest.countWorkflowStartPendingTimeouts(
				[
					`{"level":"warning","error":"workflow_start_pending_timeout","instance_id":"sw-1"}`,
					`terminated session workflow reason=workflow_start_pending_timeout`,
					`ordinary workflow progress log`,
				].join("\n"),
			);

		expect(count).toBe(2);
	});

	it("ignores terminating pods for readiness-sensitive pressure checks", () => {
		const ready = __daprWorkflowCapacityForTest.podIsReady({
			metadata: { name: "workflow-orchestrator-current" },
			status: {
				phase: "Running",
				conditions: [{ type: "Ready", status: "True" }],
			},
		});
		const terminating = __daprWorkflowCapacityForTest.podIsReady({
			metadata: {
				name: "workflow-orchestrator-old",
				deletionTimestamp: "2026-05-23T19:30:00Z",
			} as never,
			status: {
				phase: "Running",
				conditions: [{ type: "Ready", status: "True" }],
			},
		});

		expect(ready).toBe(true);
		expect(terminating).toBe(false);
	});

	it("detects Kueue benchmark agent-host pods and app OOM kills", () => {
		const pod = {
			metadata: { name: "agent-host-agent-session-abc123" },
			status: {
				phase: "Running",
				containerStatuses: [
					{
						name: "dapr-agent-py",
						state: {
							terminated: { reason: "OOMKilled", exitCode: 137 },
						},
					},
					{
						name: "daprd",
						state: { running: { startedAt: "2026-05-24T20:00:00Z" } },
					},
				],
			},
		} as never;

		expect(__daprWorkflowCapacityForTest.podIsAgentHost(pod)).toBe(true);
		expect(__daprWorkflowCapacityForTest.appContainerWasOomKilled(pod)).toBe(true);
	});

	it("uses a short default Dapr log window but allows operator tuning", () => {
		expect(__daprWorkflowCapacityForTest.daprLogWindowSeconds()).toBe(300);

		process.env.BENCHMARK_DAPR_LOG_WINDOW_SECONDS = "45";
		expect(__daprWorkflowCapacityForTest.daprLogWindowSeconds()).toBe(45);

		process.env.BENCHMARK_DAPR_LOG_WINDOW_SECONDS = "0";
		expect(__daprWorkflowCapacityForTest.daprLogWindowSeconds()).toBe(300);
	});

	it("applies startup grace before treating young agent hosts as pressure", () => {
		const now = Date.parse("2026-05-24T23:46:35Z");
		const youngPod = {
			metadata: {
				name: "agent-host-agent-session-young",
				creationTimestamp: "2026-05-24T23:46:04Z",
			},
			status: { phase: "Running" },
		} as never;
		const oldPod = {
			metadata: {
				name: "agent-host-agent-session-old",
				creationTimestamp: "2026-05-24T23:44:04Z",
			},
			status: { phase: "Running" },
		} as never;

		expect(__daprWorkflowCapacityForTest.agentHostStartupGraceSeconds()).toBe(90);
		expect(__daprWorkflowCapacityForTest.podAgeSeconds(youngPod, now)).toBe(31);
		expect(__daprWorkflowCapacityForTest.podPastStartupGrace(youngPod, 90, now)).toBe(false);
		expect(__daprWorkflowCapacityForTest.podPastStartupGrace(oldPod, 90, now)).toBe(true);

		process.env.BENCHMARK_AGENT_HOST_STARTUP_GRACE_SECONDS = "15";
		expect(__daprWorkflowCapacityForTest.agentHostStartupGraceSeconds()).toBe(15);
	});

	it("parses connected workflow workers from nested readyz payloads", () => {
		expect(
			__daprWorkflowCapacityForTest.parseReadyz({
				status: "ready",
				taskhub: { ready: true, workflowConnectedWorkers: 2 },
			}),
		).toBe(2);
	});

	it("uses the lower worker-side Dapr activity limit when it is below sidecar config", () => {
		const deployment = {
			spec: {
				template: {
					spec: {
						containers: [
							{
								name: "workflow-orchestrator",
								env: [
									{
										name: "DAPR_WORKFLOW_MAX_CONCURRENT_ORCHESTRATIONS",
										value: "128",
									},
									{
										name: "DAPR_WORKFLOW_MAX_CONCURRENT_ACTIVITIES",
										value: "192",
									},
								],
							},
						],
					},
				},
			},
		};

		expect(
			__daprWorkflowCapacityForTest.loadWorkerDaprLimitsFromDeployment(
				deployment,
				"workflow-orchestrator",
			),
		).toEqual({
			workflowLimitPerSidecar: 128,
			activityLimitPerSidecar: 192,
		});
		expect(__daprWorkflowCapacityForTest.finiteMin([512, 192])).toBe(192);
	});
});
