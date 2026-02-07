/**
 * Piece Executor
 *
 * Loads the AP piece, finds the action, builds the context, and runs it.
 */
import { getPiece } from './piece-registry.js';
import { buildActionContext } from './context-factory.js';
import type { ExecuteRequest } from './types.js';

export interface ExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  pause?: {
    type: 'DELAY' | 'WEBHOOK';
    resumeDateTime?: string;
    requestId?: string;
    response?: unknown;
  };
}

/**
 * Resolve pieceName and actionName from the request.
 *
 * Priority:
 * 1. metadata.pieceName / metadata.actionName (explicit from function-router)
 * 2. Infer from step name format: if step contains "/", split as pieceName/actionName
 * 3. Fall back to step as actionName (requires metadata.pieceName)
 */
function resolveNames(request: ExecuteRequest): {
  pieceName: string;
  actionName: string;
} {
  if (request.metadata?.pieceName && request.metadata?.actionName) {
    return {
      pieceName: request.metadata.pieceName,
      actionName: request.metadata.actionName,
    };
  }

  // The step name might be in "pieceName/actionName" format
  const slashIdx = request.step.indexOf('/');
  if (slashIdx > 0) {
    return {
      pieceName: request.step.slice(0, slashIdx),
      actionName: request.step.slice(slashIdx + 1),
    };
  }

  // Fall back to metadata.pieceName + step as action
  if (request.metadata?.pieceName) {
    return {
      pieceName: request.metadata.pieceName,
      actionName: request.step,
    };
  }

  throw new Error(
    `Cannot resolve piece and action names from step "${request.step}". ` +
      `Provide metadata.pieceName/actionName or use "pieceName/actionName" format.`
  );
}

/**
 * Resolve auth from request.
 *
 * Priority:
 * 1. credentials_raw — raw AppConnectionValue (ideal for AP actions)
 * 2. credentials — env-var-mapped credentials (legacy, less useful for AP)
 */
function resolveAuth(request: ExecuteRequest): unknown {
  if (request.credentials_raw != null) {
    return request.credentials_raw;
  }

  // Legacy: if we have env-var credentials, wrap as SECRET_TEXT if only one key
  if (request.credentials && Object.keys(request.credentials).length > 0) {
    const values = Object.values(request.credentials);
    if (values.length === 1) {
      return {
        type: 'SECRET_TEXT',
        secret_text: values[0],
      };
    }
    // Return as-is, let the piece handle it
    return request.credentials;
  }

  return undefined;
}

/**
 * Execute an Activepieces action.
 */
export async function executeAction(
  request: ExecuteRequest
): Promise<ExecutionResult> {
  const { pieceName, actionName } = resolveNames(request);

  console.log(
    `[fn-activepieces] Executing ${pieceName}/${actionName}`
  );

  // Look up piece
  const piece = getPiece(pieceName);
  if (!piece) {
    return {
      success: false,
      error: `Piece "${pieceName}" is not installed in fn-activepieces. ` +
        `Available pieces: ${(await import('./piece-registry.js')).listPieceNames().join(', ')}`,
    };
  }

  // Look up action
  const action = piece.getAction(actionName);
  if (!action) {
    return {
      success: false,
      error: `Action "${actionName}" not found in piece "${pieceName}". ` +
        `Check the piece metadata for available action names.`,
    };
  }

  // Resolve auth
  const auth = resolveAuth(request);

  // Build context (includes pauseRef to capture pause requests)
  const { context, pauseRef } = buildActionContext({
    auth,
    propsValue: request.input,
    executionId: request.execution_id,
    actionName,
  });

  // Execute the action
  try {
    const result = await action.run(context);

    // Check if the action requested a pause (DELAY or WEBHOOK)
    if (pauseRef.value) {
      console.log(
        `[fn-activepieces] Action ${pieceName}/${actionName} requested pause: type=${pauseRef.value.type}`
      );
      return {
        success: true,
        data: result,
        pause: pauseRef.value,
      };
    }

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(
      `[fn-activepieces] Action ${pieceName}/${actionName} failed:`,
      error
    );
    return {
      success: false,
      error: `Action execution failed: ${message}`,
    };
  }
}
