/**
 * Inline-resolver — walks the normalized IR, fetches each code_function
 * referenced by a `code/<slug>` call, and rewrites the call to a direct
 * invocation. Source snippets get a banner comment with slug/version/sha1.
 *
 * Skipped cases (left as shim dispatch):
 *   - Called code_function has role === 'workflow' (prevents unbounded recursion)
 *   - Called code_function's language does NOT match the emission target
 *   - Called code_function is missing (deleted, or no permission)
 *   - Non-code/* slugs (AP pieces, system/*, workspace/*, durable/run, etc.)
 */

import { createHash } from 'node:crypto';
import { getCodeFunctionBySlugForUser } from '$lib/server/code-functions';
import type { EmitNode, InlinedFunction } from './ir';

export interface ResolveInlineArgs {
	steps: EmitNode[];
	language: 'typescript' | 'python';
	userId?: string | null;
	warnings: string[];
}

export interface ResolveInlineResult {
	steps: EmitNode[];
	inlinedFunctions: InlinedFunction[];
}

const CODE_PREFIX = 'code/';

export async function resolveInlines(
	args: ResolveInlineArgs,
): Promise<ResolveInlineResult> {
	const { steps, language, userId, warnings } = args;
	const inlined = new Map<string, InlinedFunction>();
	const usedIdentifiers = new Set<string>();

	async function walk(nodes: EmitNode[]): Promise<EmitNode[]> {
		const result: EmitNode[] = [];
		for (const node of nodes) {
			if (node.kind === 'call' && node.slug.startsWith(CODE_PREFIX)) {
				const slug = node.slug.slice(CODE_PREFIX.length);
				try {
					const detail = await getCodeFunctionBySlugForUser(slug, userId);
					if (!detail) {
						warnings.push(
							`Code function "code/${slug}" not found; leaving as shim dispatch.`,
						);
					} else if (detail.role === 'workflow') {
						warnings.push(
							`Code function "code/${slug}" has role=workflow; leaving as shim dispatch to avoid unbounded recursion.`,
						);
					} else if (detail.language !== language) {
						warnings.push(
							`Code function "code/${slug}" is ${detail.language}; cannot inline into ${language} emission.`,
						);
					} else {
						const identifier = uniqueIdentifier(
							detail.entrypoint || 'inlined',
							language,
							usedIdentifiers,
						);
						const rewritten = rewriteEntrypoint(
							detail.source,
							detail.entrypoint || 'main',
							identifier,
							language,
						);
						const sha = createHash('sha1')
							.update(detail.source)
							.digest('hex')
							.slice(0, 8);
						const fn: InlinedFunction = {
							identifier,
							slug,
							version:
								detail.latestPublishedVersion || detail.version || '0.1.0',
							sha,
							sourceSnippet: rewritten,
							language,
							supportingFiles: detail.supportingFiles ?? {},
						};
						inlined.set(identifier, fn);
						result.push({ ...node, inlined: fn });
						continue;
					}
				} catch (err) {
					warnings.push(
						`Failed to resolve code/${slug} for inlining: ${(err as Error).message}`,
					);
				}
				result.push(node);
				continue;
			}

			if (node.kind === 'for') {
				result.push({ ...node, body: await walk(node.body) });
				continue;
			}
			if (node.kind === 'try') {
				result.push({
					...node,
					tryBody: await walk(node.tryBody),
					catchBody: node.catchBody ? await walk(node.catchBody) : null,
				});
				continue;
			}
			if (node.kind === 'do') {
				result.push({ ...node, steps: await walk(node.steps) });
				continue;
			}
			result.push(node);
		}
		return result;
	}

	const rewritten = await walk(steps);
	return {
		steps: rewritten,
		inlinedFunctions: [...inlined.values()],
	};
}

function uniqueIdentifier(
	base: string,
	language: 'typescript' | 'python',
	used: Set<string>,
): string {
	const sanitized = sanitizeIdentifier(base, language);
	if (!used.has(sanitized)) {
		used.add(sanitized);
		return sanitized;
	}
	for (let i = 2; ; i++) {
		const candidate = `${sanitized}_${i}`;
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
	}
}

function sanitizeIdentifier(raw: string, language: 'typescript' | 'python'): string {
	let cleaned = raw.replace(/[^a-zA-Z0-9_]/g, '_');
	if (!cleaned) cleaned = 'inlined';
	if (/^[0-9]/.test(cleaned)) cleaned = `_${cleaned}`;
	if (language === 'typescript') {
		return toCamelCase(cleaned);
	}
	return toSnakeCase(cleaned);
}

function toCamelCase(raw: string): string {
	return raw
		.split(/_+/)
		.map((part, idx) =>
			idx === 0
				? part.charAt(0).toLowerCase() + part.slice(1)
				: part.charAt(0).toUpperCase() + part.slice(1),
		)
		.join('')
		.replace(/[^a-zA-Z0-9]/g, '') || 'inlined';
}

function toSnakeCase(raw: string): string {
	return raw
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '') || 'inlined';
}

/**
 * Rewrite the entrypoint name in the source so it matches the emitted
 * identifier. Uses simple regex-based rewriting — best-effort for v1; a more
 * robust implementation would reuse the code-parser AST. Callers that see
 * diagnostics in the emitted source can fall back to shim dispatch.
 */
function rewriteEntrypoint(
	source: string,
	originalName: string,
	newName: string,
	language: 'typescript' | 'python',
): string {
	if (!originalName || originalName === newName) return source;
	const safe = originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (language === 'typescript') {
		const patterns: Array<[RegExp, string]> = [
			[new RegExp(`(\\bexport\\s+(?:default\\s+)?async\\s+function\\s+)${safe}\\b`, 'g'), `$1${newName}`],
			[new RegExp(`(\\basync\\s+function\\s+)${safe}\\b`, 'g'), `$1${newName}`],
			[new RegExp(`(\\bexport\\s+(?:default\\s+)?function\\s+)${safe}\\b`, 'g'), `$1${newName}`],
			[new RegExp(`(\\bfunction\\s+)${safe}\\b`, 'g'), `$1${newName}`],
			[new RegExp(`(\\bexport\\s+const\\s+)${safe}(\\s*=)`, 'g'), `$1${newName}$2`],
			[new RegExp(`(\\bconst\\s+)${safe}(\\s*=)`, 'g'), `$1${newName}$2`],
		];
		let rewritten = source;
		for (const [pattern, replacement] of patterns) {
			rewritten = rewritten.replace(pattern, replacement);
		}
		return rewritten;
	}
	// python
	const patterns: Array<[RegExp, string]> = [
		[new RegExp(`(^|\\n)(\\s*)async\\s+def\\s+${safe}\\s*\\(`, 'g'), `$1$2async def ${newName}(`],
		[new RegExp(`(^|\\n)(\\s*)def\\s+${safe}\\s*\\(`, 'g'), `$1$2def ${newName}(`],
	];
	let rewritten = source;
	for (const [pattern, replacement] of patterns) {
		rewritten = rewritten.replace(pattern, replacement);
	}
	return rewritten;
}
