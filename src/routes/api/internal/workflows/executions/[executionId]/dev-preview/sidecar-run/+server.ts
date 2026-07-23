import type { RequestHandler } from "./$types";
import { handlePreviewWorkspaceAction } from "../../../../../_shared/preview-workspace-action";

export const POST: RequestHandler = ({ params, request }) =>
  handlePreviewWorkspaceAction({
    mode: "run",
    rawExecutionId: params.executionId,
    request,
  });
