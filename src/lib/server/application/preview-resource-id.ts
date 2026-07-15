// Workflow execution and file identifiers use Nanoid's URL-safe alphabet.
// Legacy identifiers may additionally contain dots or colons after the first
// character. Slashes, whitespace, and control characters remain barred.
const PREVIEW_RESOURCE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/;

export function isPreviewResourceId(value: string): boolean {
	return PREVIEW_RESOURCE_ID.test(value);
}
