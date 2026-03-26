import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { workflows, users } from "../lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(client, { schema: { workflows, users } });

async function main() {
  const user = await db.query.users.findFirst({
    orderBy: [desc(users.createdAt)],
  });

  // Delete old test workflow if it exists
  await db.delete(workflows).where(eq(workflows.name, "Timeout Fix Test (next-learn)"));

  const wfId = nanoid(21);
  const triggerId = "test-trigger-001";
  const profileId = "test-profile-001";
  const cloneId = "test-clone-001";
  const installId = "test-install-001";
  const devServerId = "test-devserver-001";
  const captureId = "test-capture-001";

  const wsRef = `{{@${profileId}:Workspace Profile.workspaceRef}}`;

  const nodes = [
    {
      id: triggerId,
      type: "trigger",
      position: { x: 12, y: 12 },
      data: {
        type: "trigger",
        label: "Manual Trigger",
        description: "Test timeout fix with vercel/next-learn",
        config: { triggerType: "Manual", inputSchema: "[]" },
        status: "idle",
      },
    },
    {
      id: profileId,
      type: "action",
      position: { x: 12, y: 224 },
      data: {
        type: "action",
        label: "Workspace Profile",
        description: "Create browser workspace session",
        config: {
          name: "timeout-test-nextlearn",
          actionType: "browser/profile",
          enabledTools: JSON.stringify([
            "read",
            "write",
            "edit",
            "list",
            "bash",
          ]),
          commandTimeoutMs: "600000",
          sandboxTemplate: "aio-browser",
        },
        status: "idle",
      },
    },
    {
      id: cloneId,
      type: "action",
      position: { x: 12, y: 436 },
      data: {
        type: "action",
        label: "Clone next-learn",
        description: "Clone vercel/next-learn (public, ~5MB)",
        config: {
          actionType: "browser/clone",
          workspaceRef: wsRef,
          repositoryOwner: "PittampalliOrg",
          repositoryRepo: "next-learn",
          repositoryBranch: "main",
          targetDir: "next-learn",
        },
        status: "idle",
      },
    },
    {
      id: installId,
      type: "action",
      position: { x: 12, y: 648 },
      data: {
        type: "action",
        label: "Install Dependencies",
        description: "npm install in next-learn dashboard example",
        config: {
          actionType: "browser/command",
          workspaceRef: wsRef,
          command:
            "(while true; do echo install-heartbeat; sleep 25; done &) ; " +
            "cd next-learn/dashboard/final-example && " +
            "npm install --no-audit --no-fund --loglevel=warn 2>&1 && echo INSTALL_SUCCESS",
          timeoutMs: "600000",
        },
        status: "idle",
      },
    },
    {
      id: devServerId,
      type: "action",
      position: { x: 12, y: 860 },
      data: {
        type: "action",
        label: "Start Dev Server",
        description: "Start Next.js dev server on port 3000",
        config: {
          actionType: "browser/command",
          workspaceRef: wsRef,
          command:
            "cd next-learn/dashboard/final-example && " +
            "mkdir -p .wf-preview && rm -f .wf-preview/dev-server.log .wf-preview/dev-server.pid && " +
            "setsid sh -c 'npx next dev --hostname 0.0.0.0 > .wf-preview/dev-server.log 2>&1 < /dev/null' >/dev/null 2>&1 & pid=$!; " +
            "echo $pid > .wf-preview/dev-server.pid; sleep 5; " +
            "if ! kill -0 $pid 2>/dev/null; then echo server-exited; cat .wf-preview/dev-server.log; exit 1; fi; echo server-started",
          timeoutMs: "300000",
        },
        status: "idle",
      },
    },
    {
      id: captureId,
      type: "action",
      position: { x: 12, y: 1072 },
      data: {
        type: "action",
        label: "Browser Capture Flow",
        description: "Navigate the app and take screenshots",
        config: {
          actionType: "browser/capture-flow",
          workspaceRef: wsRef,
          baseUrl: "http://127.0.0.1:3000",
          steps: JSON.stringify([
            {
              id: "home",
              label: "Home Page",
              path: "/",
              waitForSelector: "body",
              delayMs: 3000,
            },
          ]),
          timeoutMs: "120000",
        },
        status: "idle",
      },
    },
  ];

  const edges = [
    { id: "e1", type: "animated", source: triggerId, target: profileId },
    { id: "e2", type: "animated", source: profileId, target: cloneId },
    { id: "e3", type: "animated", source: cloneId, target: installId },
    { id: "e4", type: "animated", source: installId, target: devServerId },
    { id: "e5", type: "animated", source: devServerId, target: captureId },
  ];

  const [wf] = await db
    .insert(workflows)
    .values({
      id: wfId,
      name: "Timeout Fix Test (next-learn)",
      nodes: nodes as any,
      edges: edges as any,
      userId: user?.id || "system",
      engineType: "dapr",
    })
    .returning();

  console.log("Created workflow:", wf.id);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
