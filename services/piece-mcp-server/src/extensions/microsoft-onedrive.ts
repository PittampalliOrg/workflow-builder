/**
 * Microsoft OneDrive extensions.
 *
 * Supplementary actions that layer on top of the vendored
 * `@activepieces/piece-microsoft-onedrive` package without forking it.
 * The vendored piece covers small (<4 MB) simple-PUT uploads but routes
 * large (>4 MB) through Microsoft Graph's resumable `createUploadSession`
 * protocol. This extension exposes that same createUploadSession mechanism
 * as its own MCP tool so agents can use it for ALL sizes — bypassing the
 * hard-to-shepherd-via-LLM-tool-call-args base64 payload entirely.
 *
 * Flow the agent uses:
 *   1. `create_upload_session({fileName, parentFolderId?})` → returns
 *      `{uploadUrl, expirationDateTime}`. Tiny request + response, no binary.
 *   2. `execute_command` inside the sandbox:
 *        curl -X PUT --data-binary @/sandbox/file.pptx \
 *          -H "Content-Length: <size>" \
 *          -H "Content-Range: bytes 0-<size-1>/<size>" "$uploadUrl"
 *      The uploadUrl is pre-authenticated (signed token in the URL itself)
 *      so no bearer-token plumbing into the sandbox is needed.
 *   3. Done — file bytes go sandbox→Graph directly, never touch the LLM.
 *
 * Maintainability: we only import the stable `oneDriveAuth` + `oneDriveCommon`
 * surface from the vendored package. Upstream version bumps of the piece
 * don't affect this file unless those two exports change, in which case it's
 * a one-line fix.
 */

import { oneDriveAuth } from "@activepieces/piece-microsoft-onedrive";
import { createAction, Property } from "@activepieces/pieces-framework";
import {
	httpClient,
	HttpMethod,
	AuthenticationType,
} from "@activepieces/pieces-common";

// The piece's internal `oneDriveCommon.baseUrl` is NOT re-exported from the
// package main entry — only `oneDriveAuth` is public surface. Graph's OneDrive
// base URL is stable (/v1.0/me/drive) so inlining it here is acceptable and
// keeps us off deep-imports that break on piece version bumps.
const ONEDRIVE_BASE_URL = "https://graph.microsoft.com/v1.0/me/drive";

export const createUploadSession = createAction({
	auth: oneDriveAuth,
	name: "create_upload_session",
	displayName: "Create OneDrive upload session (resumable upload)",
	description:
		"Returns a pre-authenticated `uploadUrl` for resumable upload of ANY size file. " +
		"Call this BEFORE uploading binary files (.xlsx, .pptx, etc.) — then PUT the file bytes to the returned uploadUrl with curl from the sandbox. " +
		"The uploadUrl is self-authenticated (signed token embedded), so no bearer token needs to reach the sandbox. " +
		"Use this instead of `upload_onedrive_file` for files larger than a few KB because agents can't reliably emit large base64 as tool-call JSON arguments.",
	props: {
		fileName: Property.ShortText({
			displayName: "File name",
			description:
				"Name the file will have in OneDrive (e.g. nimbus-q1-board.pptx)",
			required: true,
		}),
		parentFolderId: Property.ShortText({
			displayName: "Parent folder ID",
			description:
				"Optional — OneDrive folder item-id to upload into. Defaults to 'root'. Use list_folders to find IDs.",
			required: false,
		}),
		conflictBehavior: Property.StaticDropdown({
			displayName: "Conflict behavior",
			description:
				"What to do if a file with the same name already exists.",
			required: false,
			defaultValue: "replace",
			options: {
				options: [
					{ label: "Replace (overwrite)", value: "replace" },
					{ label: "Rename (auto-suffix)", value: "rename" },
					{ label: "Fail", value: "fail" },
				],
			},
		}),
	},
	async run(ctx) {
		const parentId =
			ctx.propsValue.parentFolderId && ctx.propsValue.parentFolderId.trim()
				? ctx.propsValue.parentFolderId.trim()
				: "root";
		const conflict = ctx.propsValue.conflictBehavior || "replace";
		const encoded = encodeURIComponent(ctx.propsValue.fileName);
		const url = `${ONEDRIVE_BASE_URL}/items/${parentId}:/${encoded}:/createUploadSession`;

		const res = await httpClient.sendRequest<{
			uploadUrl?: string;
			expirationDateTime?: string;
		}>({
			method: HttpMethod.POST,
			url,
			body: {
				item: { "@microsoft.graph.conflictBehavior": conflict },
			},
			authentication: {
				type: AuthenticationType.BEARER_TOKEN,
				token: ctx.auth.access_token,
			},
		});

		if (!res.body?.uploadUrl) {
			throw new Error(
				`createUploadSession response missing uploadUrl: ${JSON.stringify(res.body).slice(0, 300)}`,
			);
		}

		return {
			uploadUrl: res.body.uploadUrl,
			expirationDateTime: res.body.expirationDateTime ?? null,
			// Echo back the target so the agent has everything in one place.
			fileName: ctx.propsValue.fileName,
			parentFolderId: parentId,
			// Hint for the agent — one-shot curl command template.
			uploadHint:
				`curl -X PUT --data-binary @<local-file> -H "Content-Range: bytes 0-\$((<size>-1))/<size>" "<uploadUrl>"`,
		};
	},
});

export const microsoftOneDriveExtensions = [createUploadSession];
