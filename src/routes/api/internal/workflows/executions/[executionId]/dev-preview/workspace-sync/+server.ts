import type { RequestHandler } from "./$types";
import { handlePreviewWorkspaceAction } from "../../../../../_shared/preview-workspace-action";

export const POST: RequestHandler = ({ params, request }) =>
  handlePreviewWorkspaceAction({
    mode: "sync",
    rawExecutionId: params.executionId,
    request,
  });
