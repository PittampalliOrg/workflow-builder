import { createHash } from "node:crypto";
import type {
  PreviewActivationImage,
  PreviewActivationImageBuildPort,
} from "$lib/server/application/ports";
import {
  assertCanonicalTektonPipelineRun,
  createTektonPipelineRun,
  getTektonPipelineRun,
  listTektonTaskRunsForPipelineRun,
  requireTektonPipelineRunUid,
  tektonPipelineRunResults,
  tektonSucceededCondition,
  tektonTaskRunOwnedByPipelineRun,
  tektonTaskRunResults,
  type TektonPipelineRun,
  type TektonTaskRun,
} from "$lib/server/kube/tekton";
import {
  DEV_PREVIEW_CATALOG_DIGEST,
  PREVIEW_CATALOG_EXTENSIONS,
} from "$lib/server/workflows/dev-preview-registry";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SOURCE_REPOSITORY = "PittampalliOrg/workflow-builder" as const;
const TARGET_CLUSTER = "hub-preview-activation" as const;

type Sleep = (milliseconds: number) => Promise<void>;

type TektonActivationClient = Readonly<{
  create: typeof createTektonPipelineRun;
  get: typeof getTektonPipelineRun;
  listTasks: typeof listTektonTaskRunsForPipelineRun;
}>;

export type TektonPreviewActivationBuildOptions = Readonly<{
  namespace?: string;
  dockerConfigSecret?: string;
  serviceAccount?: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: Sleep;
  client?: TektonActivationClient;
}>;

/** Purpose-specific adapter; GitHub status credentials stay above this port. */
export class TektonPreviewActivationBuildAdapter implements PreviewActivationImageBuildPort {
  private readonly namespace: string;
  private readonly sleep: Sleep;
  private readonly client: TektonActivationClient;

  constructor(
    private readonly options: TektonPreviewActivationBuildOptions = {},
  ) {
    this.namespace = options.namespace ?? "tekton-pipelines";
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.client = options.client ?? {
      create: createTektonPipelineRun,
      get: getTektonPipelineRun,
      listTasks: listTektonTaskRunsForPipelineRun,
    };
  }

  async build(
    input: Parameters<PreviewActivationImageBuildPort["build"]>[0],
  ): Promise<PreviewActivationImage> {
    const activation = this.assertInput(input);
    const runName = activationPipelineRunName(
      input.artifact,
      input.sourceRevision,
      input.requestId,
    );
    const manifest = activationPipelineRunManifest({
      name: runName,
      namespace: this.namespace,
      requestId: input.requestId,
      artifact: input.artifact,
      sourceRevision: input.sourceRevision,
      pipeline: activation.pipeline,
      dockerConfigSecret:
        this.options.dockerConfigSecret ?? "ghcr-push-credentials",
      serviceAccount:
        this.options.serviceAccount ?? "activation-image-build-executor",
    });
    const submission = await this.client.create(this.namespace, manifest, {
      targetCluster: TARGET_CLUSTER,
    });
    const pipelineRunUid = submission.created
      ? requireTektonPipelineRunUid(submission.pipelineRun, {
          namespace: this.namespace,
          name: runName,
        })
      : assertCanonicalTektonPipelineRun(
          this.namespace,
          manifest,
          submission.pipelineRun,
        );
    const completed = await this.waitForPipeline(runName, pipelineRunUid);
    const condition = tektonSucceededCondition(completed);
    if (condition?.status !== "True") {
      throw new Error(
        `activation image build ${runName} failed: ${condition?.message ?? condition?.reason ?? "unknown"}`,
      );
    }
    const taskRuns = await this.client.listTasks(this.namespace, runName, {
      targetCluster: TARGET_CLUSTER,
    });
    const results = mergeBuildResults(
      tektonPipelineRunResults(completed),
      taskRuns,
      completed,
    );
    const expectedRef = `${activation.image}:git-${input.sourceRevision}`;
    if (results.image_ref !== expectedRef) {
      throw new Error(
        `activation build ${runName} returned unexpected image_ref`,
      );
    }
    if (!SHA256.test(results.image_digest ?? "")) {
      throw new Error(
        `activation build ${runName} returned no immutable digest`,
      );
    }
    const digest = results.image_digest as `sha256:${string}`;
    return Object.freeze({
      artifact: input.artifact,
      sourceRevision: input.sourceRevision,
      pipelineRun: runName,
      imageRef: expectedRef,
      digest,
      immutableRef: `${activation.image}@${digest}`,
    });
  }

  private assertInput(
    input: Parameters<PreviewActivationImageBuildPort["build"]>[0],
  ) {
    if (input.sourceRepository !== SOURCE_REPOSITORY) {
      throw new Error(
        `activation builds are restricted to ${SOURCE_REPOSITORY}`,
      );
    }
    if (!REQUEST_ID.test(input.requestId)) {
      throw new Error("activation build request id is invalid");
    }
    if (!FULL_SHA.test(input.sourceRevision)) {
      throw new Error(
        "activation build source revision must be a full Git SHA",
      );
    }
    if (input.catalogDigest !== DEV_PREVIEW_CATALOG_DIGEST) {
      throw new Error("activation build catalog digest is not current");
    }
    const descriptor = PREVIEW_CATALOG_EXTENSIONS[input.artifact];
    const activation = descriptor?.capabilities.activationBuild;
    if (
      !activation ||
      activation.statusContext !== "preview/activation-images"
    ) {
      throw new Error(
        "activation artifact is not cataloged for preview builds",
      );
    }
    return activation;
  }

  private async waitForPipeline(
    name: string,
    expectedUid: string,
  ): Promise<TektonPipelineRun> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 30 * 60_000);
    while (Date.now() < deadline) {
      const run = await this.client.get(this.namespace, name, {
        targetCluster: TARGET_CLUSTER,
      });
      if (run) {
        const observedUid = requireTektonPipelineRunUid(run, {
          namespace: this.namespace,
          name,
        });
        if (observedUid !== expectedUid) {
          throw new Error(
            `activation image build ${name} changed Kubernetes ownership`,
          );
        }
      }
      const condition = tektonSucceededCondition(run);
      if (run && condition?.status && condition.status !== "Unknown")
        return run;
      await this.sleep(this.options.pollMs ?? 5_000);
    }
    throw new Error(`activation image build ${name} timed out`);
  }
}

function activationPipelineRunName(
  artifact: string,
  revision: string,
  requestId: string,
): string {
  const requestHash = createHash("sha256")
    .update(requestId)
    .digest("hex")
    .slice(0, 8);
  return `activation-${artifact}-${revision.slice(0, 10)}-${requestHash}`;
}

function activationPipelineRunManifest(input: {
  name: string;
  namespace: string;
  requestId: string;
  artifact: string;
  sourceRevision: string;
  pipeline: string;
  dockerConfigSecret: string;
  serviceAccount: string;
}): TektonPipelineRun {
  return {
    apiVersion: "tekton.dev/v1",
    kind: "PipelineRun",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: {
        "app.kubernetes.io/part-of": "hub-tekton",
        "stacks.io/build-loop": "activation",
        "stacks.io/image-name": input.artifact,
        "preview.stacks.io/source-revision": input.sourceRevision,
      },
      annotations: {
        "preview.stacks.io/request-id": input.requestId,
        "preview.stacks.io/catalog-digest": DEV_PREVIEW_CATALOG_DIGEST,
      },
    },
    spec: {
      pipelineRef: { name: input.pipeline },
      params: [{ name: "source_revision", value: input.sourceRevision }],
      workspaces: [
        { name: "shared-workspace", emptyDir: {} },
        {
          name: "dockerconfig",
          secret: { secretName: input.dockerConfigSecret },
        },
      ],
      taskRunTemplate: {
        serviceAccountName: input.serviceAccount,
        podTemplate: {
          hostUsers: false,
          nodeSelector: { "stacks.io/build-pool": "hub" },
          tolerations: [
            {
              key: "stacks.io/build-pool",
              operator: "Equal",
              value: "hub",
              effect: "NoSchedule",
            },
          ],
          securityContext: { fsGroup: 65532 },
        },
      },
      timeouts: { pipeline: "1h0m0s" },
    },
  };
}

function mergeBuildResults(
  pipeline: Record<string, string>,
  tasks: TektonTaskRun[],
  pipelineRun: TektonPipelineRun,
): Record<string, string> {
  const taskResults: Record<string, string> = {};
  for (const task of tasks) {
    if (!tektonTaskRunOwnedByPipelineRun(task, pipelineRun)) continue;
    Object.assign(taskResults, tektonTaskRunResults(task));
  }
  return { ...taskResults, ...pipeline };
}
