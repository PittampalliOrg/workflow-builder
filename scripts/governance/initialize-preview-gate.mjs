#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  classifyWorkflowBuilderPreviewGate,
  PREVIEW_GATE_CONTEXT,
} from "./preview-gate-domain.mjs";
import {
  GitHubAppWorkflowPreviewGateCredentials,
  GitHubPreviewGateAdapter,
} from "./preview-gate-github-adapter.mjs";

export async function initializeWorkflowBuilderPreviewGate({
  tuple,
  catalog,
  github,
}) {
  const pullRequest = await github.inspect(tuple);
  let decision;
  try {
    decision = classifyWorkflowBuilderPreviewGate(
      catalog,
      pullRequest.changedPaths,
    );
  } catch (error) {
    await github.inspect(tuple);
    await github.publish(tuple, {
      context: PREVIEW_GATE_CONTEXT,
      state: "error",
      description: "Preview gate classification failed closed",
    });
    throw error;
  }
  await github.inspect(tuple);
  const publications = [
    github.publish(tuple, {
      context: PREVIEW_GATE_CONTEXT,
      state: decision.state,
      description: decision.description,
    }),
  ];
  if (decision.kind === "evidence-required") {
    for (const context of decision.contexts) {
      publications.push(
        github.publish(tuple, {
          context,
        state: "pending",
        description: decision.description,
        }),
      );
    }
  }
  await Promise.all(publications);
  return decision;
}

async function main() {
  const tuple = {
    repository: process.env.PREVIEW_GATE_REPOSITORY ?? "",
    pullRequestNumber: Number(process.env.PREVIEW_GATE_PULL_REQUEST ?? ""),
    baseSha: process.env.PREVIEW_GATE_BASE_SHA ?? "",
    headSha: process.env.PREVIEW_GATE_HEAD_SHA ?? "",
  };
  const checkedOut = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (checkedOut !== tuple.baseSha) {
    throw new Error("trusted gate checkout does not match the exact PR base SHA");
  }
  const catalog = JSON.parse(
    await readFile("services/shared/dev-preview-service-catalog.json", "utf8"),
  );
  const credentials = new GitHubAppWorkflowPreviewGateCredentials();
  const github = new GitHubPreviewGateAdapter({ token: await credentials.token() });
  const decision = await initializeWorkflowBuilderPreviewGate({
    tuple,
    catalog,
    github,
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
