/**
 * Persist State Activity
 *
 * Saves workflow state and outputs to Dapr state store.
 * Used for checkpointing and storing intermediate results.
 */
import { DaprClient } from "@dapr/dapr";

const STATE_STORE_NAME = process.env.STATE_STORE_NAME || "workflowstatestore";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

/**
 * Input for the persist state activity
 */
export interface PersistStateInput {
  key: string;
  value: unknown;
  metadata?: Record<string, string>;
}

/**
 * Output from the persist state activity
 */
export interface PersistStateOutput {
  success: boolean;
  key: string;
  error?: string;
}

/**
 * Save state to Dapr state store
 *
 * Note: Dapr activities receive (ctx, input) but we don't need the ctx here
 */
export async function persistState(
  _ctx: unknown,
  input: PersistStateInput
): Promise<PersistStateOutput> {
  const { key, value, metadata } = input;

  console.log(`[Persist State] Saving state with key: ${key}`);

  try {
    const client = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    await client.state.save(STATE_STORE_NAME, [
      {
        key,
        value,
        metadata,
      },
    ]);

    console.log(`[Persist State] Successfully saved state: ${key}`);

    return {
      success: true,
      key,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    console.error(`[Persist State] Failed to save state ${key}:`, error);

    return {
      success: false,
      key,
      error: `Failed to persist state: ${errorMessage}`,
    };
  }
}

/**
 * Input for the get state activity
 */
export interface GetStateInput {
  key: string;
}

/**
 * Output from the get state activity
 */
export interface GetStateOutput {
  success: boolean;
  key: string;
  value?: unknown;
  error?: string;
}

/**
 * Get state from Dapr state store
 *
 * Note: Dapr activities receive (ctx, input) but we don't need the ctx here
 */
export async function getState(_ctx: unknown, input: GetStateInput): Promise<GetStateOutput> {
  const { key } = input;

  console.log(`[Get State] Retrieving state with key: ${key}`);

  try {
    const client = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    const result = await client.state.get(STATE_STORE_NAME, key);

    console.log(`[Get State] Successfully retrieved state: ${key}`);

    return {
      success: true,
      key,
      value: result,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    console.error(`[Get State] Failed to get state ${key}:`, error);

    return {
      success: false,
      key,
      error: `Failed to get state: ${errorMessage}`,
    };
  }
}

/**
 * Delete state from Dapr state store
 *
 * Note: Dapr activities receive (ctx, input) but we don't need the ctx here
 */
export async function deleteState(
  _ctx: unknown,
  input: GetStateInput
): Promise<PersistStateOutput> {
  const { key } = input;

  console.log(`[Delete State] Deleting state with key: ${key}`);

  try {
    const client = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    await client.state.delete(STATE_STORE_NAME, key);

    console.log(`[Delete State] Successfully deleted state: ${key}`);

    return {
      success: true,
      key,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    console.error(`[Delete State] Failed to delete state ${key}:`, error);

    return {
      success: false,
      key,
      error: `Failed to delete state: ${errorMessage}`,
    };
  }
}
