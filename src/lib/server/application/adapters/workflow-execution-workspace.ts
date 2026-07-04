import { createHash } from "node:crypto";
import type { WorkflowExecutionWorkspacePort } from "$lib/server/application/ports";
import { createJuiceFsWebdavClient } from "$lib/server/workflows/juicefs-webdav";

export type JuiceFsWorkflowExecutionWorkspaceAdapterConfig = {
  baseUrl?: string | null;
  username?: string | null;
  password?: string | null;
  databaseUrl?: string | null;
};

export function resolveJuiceFsWebdavPassword(
  config: Pick<
    JuiceFsWorkflowExecutionWorkspaceAdapterConfig,
    "password" | "databaseUrl"
  >,
) {
  if (config.password) return config.password;
  if (!config.databaseUrl) return null;
  return createHash("sha256")
    .update(`webdav:wfbcli:${config.databaseUrl}`)
    .digest("hex")
    .slice(0, 32);
}

export class JuiceFsWorkflowExecutionWorkspaceAdapter implements WorkflowExecutionWorkspacePort {
  private readonly client;

  constructor(
    config: JuiceFsWorkflowExecutionWorkspaceAdapterConfig = process.env,
  ) {
    this.client = createJuiceFsWebdavClient({
      baseUrl: config.baseUrl ?? process.env.JUICEFS_WEBDAV_URL,
      username:
        config.username ?? process.env.JUICEFS_WEBDAV_USER ?? "wfbwebdav",
      password: resolveJuiceFsWebdavPassword({
        password: config.password ?? process.env.JUICEFS_WEBDAV_PASSWORD,
        databaseUrl: config.databaseUrl ?? process.env.DATABASE_URL,
      }),
    });
  }

  listTree(instanceId: string) {
    return this.client.listWorkspaceTree(instanceId);
  }

  readFile(instanceId: string, relPath: string) {
    return this.client.readWorkspaceFile(instanceId, relPath);
  }
}
