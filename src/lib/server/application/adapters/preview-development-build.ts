import { createHash } from "node:crypto";
import type {
  ImmutableGitSha,
  PreviewDevelopmentImage,
  PreviewEnvironmentDevelopmentImageBuildPort,
} from "$lib/server/application/ports";
import { PREVIEW_DEVELOPMENT_SOURCE_REPOSITORY } from "$lib/server/application/ports";
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
  DEV_PREVIEW_SERVICES,
  resolveRequestedDevPreviewServiceSet,
} from "$lib/server/workflows/dev-preview-registry";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TARGET_CLUSTER = "hub-preview-development" as const;

type Sleep = (milliseconds: number) => Promise<void>;

type TektonDevelopmentClient = Readonly<{
  create: typeof createTektonPipelineRun;
  get: typeof getTektonPipelineRun;
  listTasks: typeof listTektonTaskRunsForPipelineRun;
}>;

export type TektonPreviewDevelopmentBuildOptions = Readonly<{
  namespace?: string;
  dockerConfigSecret?: string;
  serviceAccount?: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: Sleep;
  client?: TektonDevelopmentClient;
}>;

/** Bounded hub adapter for rebuilding one cataloged development image. */
export class TektonPreviewDevelopmentBuildAdapter implements PreviewEnvironmentDevelopmentImageBuildPort {
  private readonly namespace: string;
  private readonly sleep: Sleep;
  private readonly client: TektonDevelopmentClient;

  constructor(
    private readonly options: TektonPreviewDevelopmentBuildOptions = {},
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
    input: Parameters<PreviewEnvironmentDevelopmentImageBuildPort["build"]>[0],
  ): Promise<PreviewDevelopmentImage> {
    this.assertInput(input);
    const descriptor = DEV_PREVIEW_SERVICES[input.service];
    const build = descriptor.devBuild;
    const runName = developmentPipelineRunName(
      input.service,
      input.sourceRevision,
      input.requestId,
    );
    const manifest = developmentPipelineRunManifest({
      name: runName,
      namespace: this.namespace,
      requestId: input.requestId,
      sourceRevision: input.sourceRevision,
      service: input.service,
      image: build.image,
      dockerfile: build.dockerfile,
      context: build.context,
      dockerConfigSecret:
        this.options.dockerConfigSecret ?? "ghcr-push-credentials",
      serviceAccount:
        this.options.serviceAccount ?? "preview-development-build-executor",
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
        `development image build ${runName} failed: ${condition?.message ?? condition?.reason ?? "unknown"}`,
      );
    }
    const pipelineResults = tektonPipelineRunResults(completed);
    const taskRuns = await this.client.listTasks(this.namespace, runName, {
      targetCluster: TARGET_CLUSTER,
    });
    const results = mergeBuildResults(pipelineResults, taskRuns, completed);
    const expectedRef = `${build.image}:git-${input.sourceRevision}`;
    if (results.image_ref !== expectedRef) {
      throw new Error(
        `development image build ${runName} returned unexpected image_ref`,
      );
    }
    if (!SHA256.test(results.image_digest ?? "")) {
      throw new Error(
        `development image build ${runName} returned no immutable digest`,
      );
    }
    const digest = results.image_digest as `sha256:${string}`;
    return Object.freeze({
      service: input.service,
      sourceRevision: input.sourceRevision,
      buildId: runName,
      imageRef: expectedRef,
      digest,
      immutableRef: `${build.image}@${digest}`,
    });
  }

  private assertInput(
    input: Parameters<PreviewEnvironmentDevelopmentImageBuildPort["build"]>[0],
  ): void {
    if (input.sourceRepository !== PREVIEW_DEVELOPMENT_SOURCE_REPOSITORY) {
      throw new Error(
        `development builds are restricted to ${PREVIEW_DEVELOPMENT_SOURCE_REPOSITORY}`,
      );
    }
    if (!REQUEST_ID.test(input.requestId)) {
      throw new Error("development build request id is invalid");
    }
    if (!FULL_SHA.test(input.sourceRevision)) {
      throw new Error(
        "development build source revision must be a full Git SHA",
      );
    }
    if (input.catalogDigest !== DEV_PREVIEW_CATALOG_DIGEST) {
      throw new Error("development build catalog digest is not current");
    }
    const resolved = resolveRequestedDevPreviewServiceSet(
      [input.service],
      "preview-native",
    );
    if (
      resolved.rejected.length > 0 ||
      resolved.services.length !== 1 ||
      resolved.services[0] !== input.service
    ) {
      throw new Error(
        "development build received an unsupported preview-native service",
      );
    }
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
            `development image build ${name} changed Kubernetes ownership`,
          );
        }
      }
      const condition = tektonSucceededCondition(run);
      if (run && condition?.status && condition.status !== "Unknown")
        return run;
      await this.sleep(this.options.pollMs ?? 5_000);
    }
    throw new Error(`development image build ${name} timed out`);
  }
}

function developmentPipelineRunName(
  service: string,
  revision: string,
  requestId: string,
): string {
  const requestHash = createHash("sha256")
    .update(requestId)
    .digest("hex")
    .slice(0, 8);
  return `preview-dev-${service}-${revision.slice(0, 10)}-${requestHash}`.slice(
    0,
    63,
  );
}

function developmentPipelineRunManifest(input: {
  name: string;
  namespace: string;
  requestId: string;
  sourceRevision: ImmutableGitSha;
  service: string;
  image: string;
  dockerfile: string;
  context: string;
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
        "app.kubernetes.io/part-of": "workflow-builder",
        "stacks.io/build-loop": "preview-development",
        "stacks.io/image-name": input.service,
        "preview.stacks.io/source-revision": input.sourceRevision,
      },
      annotations: {
        "preview.stacks.io/request-id": input.requestId,
        "preview.stacks.io/catalog-digest": DEV_PREVIEW_CATALOG_DIGEST,
      },
    },
    spec: {
      pipelineRef: { name: "preview-development-build" },
      timeouts: { pipeline: "45m0s" },
      params: [
        { name: "source_revision", value: input.sourceRevision },
        { name: "service", value: input.service },
        { name: "image", value: input.image },
        { name: "dockerfile", value: input.dockerfile },
        { name: "context", value: input.context },
      ],
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
