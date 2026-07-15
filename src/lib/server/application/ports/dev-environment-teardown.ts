export type DevEnvironmentTeardownInput = Readonly<{
  executionId: string;
  userId: string;
  projectId?: string | null;
  discardUncaptured?: boolean;
}>;

export type DevEnvironmentTeardownBody = Readonly<{
  ok: boolean;
  complete: boolean;
  pending: boolean;
  executionId: string;
  sandboxName?: string | null;
  sessionStopped?: string | null;
  runStopped?: string | null;
  error?: string;
}>;

export type DevEnvironmentTeardownResult =
  | Readonly<{
      status: "ok";
      httpStatus: 200 | 202;
      body: DevEnvironmentTeardownBody;
    }>
  | Readonly<{
      status: "error";
      httpStatus: 403 | 404 | 409 | 503;
      body: DevEnvironmentTeardownBody;
    }>;

/** Inbound command port for the complete product teardown state machine. */
export interface DevEnvironmentTeardownPort {
  teardown(
    input: DevEnvironmentTeardownInput,
  ): Promise<DevEnvironmentTeardownResult>;
}
