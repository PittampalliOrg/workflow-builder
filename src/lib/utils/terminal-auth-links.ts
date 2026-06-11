/**
 * Detect sign-in / OAuth URLs in interactive-cli terminal output so the web
 * terminal can surface them (copy / open in browser).
 *
 * Why: the `agy` (Antigravity) device-login prints a Google OAuth URL the user
 * must visit to authenticate, and it's easy to miss buried in the TUI. xterm's
 * WebLinksAddon already makes URLs clickable, but a one-time toast with
 * Copy/Open is far more discoverable for a blocking sign-in step. Also covers
 * any future CLI that prints a login URL (e.g. an expired claude/codex token).
 *
 * PTY output arrives as binary chunks: a URL can straddle a chunk boundary and
 * TUIs interleave ANSI escapes, so the detector keeps a small rolling tail,
 * strips ANSI before matching, and dedups by URL.
 */

const URL_RE = /https?:\/\/[^\s"'`<>\\\])}|]+/gi;

// CSI (ESC [ ...), OSC (ESC ] ... BEL/ST), and 2-byte ESC sequences. Built from
// char codes so the source stays free of invisible control bytes / fragile
// \x escapes (which editors and tooling mangle).
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(
	`${ESC}\\[[0-9;?]*[ -/]*[@-~]` + // CSI
		`|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)` + // OSC (BEL- or ST-terminated)
		`|${ESC}[@-_]`, // two-byte escapes
	'g'
);

// Heuristics for "this is a sign-in link the user must act on".
const AUTH_HINTS = [
	'accounts.google.com',
	'oauth',
	'/o/oauth2',
	'authorize',
	'/authorize',
	'/auth?',
	'/auth/',
	'/device',
	'signin',
	'sign-in',
	'/login',
	'codeassist',
	'antigravity',
	'verification_uri',
	'usercode',
];

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, '');
}

export function isAuthUrl(url: string): boolean {
	const u = url.toLowerCase();
	return AUTH_HINTS.some((h) => u.includes(h));
}

/** Trim trailing punctuation a terminal might render adjacent to the URL. */
function cleanUrl(raw: string): string {
	return raw.replace(/[.,;:!?)\]}'"]+$/, '');
}

export class AuthLinkDetector {
	private tail = '';
	private readonly seen = new Set<string>();
	private readonly maxTail: number;

	constructor(maxTail = 8192) {
		this.maxTail = maxTail;
	}

	/** Feed a decoded text chunk; returns newly-seen auth URLs (deduped). */
	push(chunk: string): string[] {
		if (!chunk) return [];
		const window = stripAnsi(this.tail + chunk);
		const found: string[] = [];
		for (const match of window.matchAll(URL_RE)) {
			const url = cleanUrl(match[0]);
			if (url.length < 12 || !isAuthUrl(url) || this.seen.has(url)) continue;
			this.seen.add(url);
			found.push(url);
		}
		// Retain a tail so a URL split across chunks is caught on the next push.
		this.tail = window.length > this.maxTail ? window.slice(-this.maxTail) : window;
		return found;
	}

	reset(): void {
		this.tail = '';
		this.seen.clear();
	}
}
