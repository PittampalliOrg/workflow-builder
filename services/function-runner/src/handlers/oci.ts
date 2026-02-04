/**
 * OCI Handler
 *
 * Executes functions by running an OCI container image as a Kubernetes Job.
 * The input is passed as an environment variable and output is captured from stdout.
 */
import {
  KubeConfig,
  BatchV1Api,
  CoreV1Api,
  V1Job,
  V1Pod,
} from "@kubernetes/client-node";
import type {
  FunctionDefinition,
  WorkflowCredentials,
  ExecuteFunctionResult,
  OciJobResult,
} from "../core/types.js";

const NAMESPACE = process.env.K8S_NAMESPACE || "workflow-builder";
const JOB_TTL_SECONDS = 60; // Clean up jobs after 60 seconds
const DEFAULT_TIMEOUT_SECONDS = 300;

export interface OciExecuteInput {
  fn: FunctionDefinition;
  input: Record<string, unknown>;
  credentials: WorkflowCredentials;
  context: {
    executionId: string;
    workflowId: string;
    nodeId: string;
    nodeName: string;
  };
}

/**
 * Generate a unique job name
 */
function generateJobName(slug: string): string {
  const safeSlug = slug.replace(/[^a-z0-9-]/g, "-").substring(0, 30);
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `fn-${safeSlug}-${timestamp}-${random}`.substring(0, 63);
}

/**
 * Execute an OCI container function as a Kubernetes Job
 */
export async function executeOci(
  options: OciExecuteInput
): Promise<ExecuteFunctionResult> {
  const { fn, input, credentials, context } = options;
  const startTime = Date.now();

  if (!fn.imageRef) {
    return {
      success: false,
      error: `OCI function ${fn.slug} has no imageRef configured`,
      duration_ms: Date.now() - startTime,
    };
  }

  const jobName = generateJobName(fn.slug);
  const timeout = fn.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  console.log(`[OCI Handler] Creating job ${jobName} for ${fn.slug}`);

  try {
    // Initialize Kubernetes client
    const kc = new KubeConfig();
    kc.loadFromCluster(); // Use in-cluster config
    const batchApi = kc.makeApiClient(BatchV1Api);
    const coreApi = kc.makeApiClient(CoreV1Api);

    // Build environment variables
    const env: { name: string; value: string }[] = [
      { name: "INPUT", value: JSON.stringify(input) },
      { name: "EXECUTION_ID", value: context.executionId },
      { name: "WORKFLOW_ID", value: context.workflowId },
      { name: "NODE_ID", value: context.nodeId },
      { name: "NODE_NAME", value: context.nodeName },
    ];

    // Add credentials as environment variables
    for (const [key, value] of Object.entries(credentials)) {
      if (value) {
        env.push({ name: key, value });
      }
    }

    // Add container-specific environment variables
    if (fn.containerEnv) {
      for (const [key, value] of Object.entries(fn.containerEnv)) {
        env.push({ name: key, value });
      }
    }

    // Create the Job spec
    const job: V1Job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        namespace: NAMESPACE,
        labels: {
          "app.kubernetes.io/name": "function-runner",
          "app.kubernetes.io/component": "oci-job",
          "workflow-builder.io/function-slug": fn.slug.replace("/", "-"),
          "workflow-builder.io/execution-id": context.executionId,
        },
      },
      spec: {
        ttlSecondsAfterFinished: JOB_TTL_SECONDS,
        activeDeadlineSeconds: timeout,
        backoffLimit: 0, // Don't retry - let the workflow orchestrator handle retries
        template: {
          metadata: {
            labels: {
              "app.kubernetes.io/name": "function-runner",
              "app.kubernetes.io/component": "oci-job",
            },
          },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "function",
                image: fn.imageRef,
                env,
                command: fn.command ? [fn.command] : undefined,
                workingDir: fn.workingDir ?? undefined,
                resources: {
                  requests: {
                    cpu: "100m",
                    memory: "128Mi",
                  },
                  limits: {
                    cpu: "500m",
                    memory: "512Mi",
                  },
                },
              },
            ],
          },
        },
      },
    };

    // Create the job
    await batchApi.createNamespacedJob({ namespace: NAMESPACE, body: job });
    console.log(`[OCI Handler] Job ${jobName} created`);

    // Wait for job completion
    const result = await waitForJobCompletion(
      batchApi,
      coreApi,
      jobName,
      timeout
    );

    return {
      success: result.success,
      data: result.output,
      error: result.error,
      duration_ms: Date.now() - startTime,
      job_name: result.jobName,
      pod_name: result.podName,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[OCI Handler] Failed to execute job ${jobName}:`, error);

    return {
      success: false,
      error: `OCI job execution failed: ${errorMessage}`,
      duration_ms: Date.now() - startTime,
      job_name: jobName,
    };
  }
}

/**
 * Wait for a Kubernetes Job to complete and retrieve the result
 */
async function waitForJobCompletion(
  batchApi: BatchV1Api,
  coreApi: CoreV1Api,
  jobName: string,
  timeoutSeconds: number
): Promise<OciJobResult> {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  const pollIntervalMs = 2000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Get job status
      const { body: job } = await batchApi.readNamespacedJob({
        name: jobName,
        namespace: NAMESPACE,
      });

      const status = job.status;

      // Check for completion
      if (status?.succeeded && status.succeeded > 0) {
        // Job completed successfully - get output from pod logs
        const output = await getPodLogs(coreApi, jobName);
        return {
          success: true,
          output: parseOutput(output),
          jobName,
          podName: await getPodName(coreApi, jobName),
          exitCode: 0,
        };
      }

      // Check for failure
      if (status?.failed && status.failed > 0) {
        const logs = await getPodLogs(coreApi, jobName);
        return {
          success: false,
          error: logs || "Job failed without output",
          jobName,
          podName: await getPodName(coreApi, jobName),
          exitCode: 1,
        };
      }

      // Check for timeout (activeDeadlineSeconds exceeded)
      if (
        status?.conditions?.some(
          (c) => c.type === "Failed" && c.reason === "DeadlineExceeded"
        )
      ) {
        return {
          success: false,
          error: `Job exceeded deadline of ${timeoutSeconds}s`,
          jobName,
        };
      }

      // Still running, wait and poll again
      await sleep(pollIntervalMs);
    } catch (error) {
      console.warn(
        `[OCI Handler] Error polling job ${jobName}:`,
        error instanceof Error ? error.message : error
      );
      await sleep(pollIntervalMs);
    }
  }

  // Timed out waiting
  return {
    success: false,
    error: `Timed out waiting for job ${jobName} after ${timeoutSeconds}s`,
    jobName,
  };
}

/**
 * Get pod name for a job
 */
async function getPodName(
  coreApi: CoreV1Api,
  jobName: string
): Promise<string | undefined> {
  try {
    const { body: pods } = await coreApi.listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: `job-name=${jobName}`,
    });
    return pods.items[0]?.metadata?.name;
  } catch {
    return undefined;
  }
}

/**
 * Get logs from job's pod
 */
async function getPodLogs(
  coreApi: CoreV1Api,
  jobName: string
): Promise<string | undefined> {
  try {
    const podName = await getPodName(coreApi, jobName);
    if (!podName) return undefined;

    const { body } = await coreApi.readNamespacedPodLog({
      name: podName,
      namespace: NAMESPACE,
      container: "function",
    });
    return body;
  } catch {
    return undefined;
  }
}

/**
 * Parse output from container stdout
 * Expects JSON on the last line, or returns raw text
 */
function parseOutput(output: string | undefined): unknown {
  if (!output) return undefined;

  // Try to parse the entire output as JSON
  try {
    return JSON.parse(output);
  } catch {
    // Try to parse just the last line as JSON
    const lines = output.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    try {
      return JSON.parse(lastLine);
    } catch {
      // Return as text
      return output;
    }
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
