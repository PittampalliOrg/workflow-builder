import { describe, it, expect } from 'vitest';
import { AuthLinkDetector, isAuthUrl, stripAnsi } from './terminal-auth-links';

const ESC = String.fromCharCode(27);

describe('isAuthUrl', () => {
	it('flags sign-in URLs and ignores ordinary ones', () => {
		expect(isAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x')).toBe(true);
		expect(isAuthUrl('https://accounts.google.com/device?user_code=AB-CD')).toBe(true);
		expect(isAuthUrl('https://antigravity.google/auth?code=z')).toBe(true);
		expect(isAuthUrl('https://example.com/login')).toBe(true);
		expect(isAuthUrl('https://openai.com/index/introducing-gpt-5-5/')).toBe(false);
		expect(isAuthUrl('https://github.com/PittampalliOrg/stacks')).toBe(false);
	});
});

describe('stripAnsi', () => {
	it('removes CSI escapes that a TUI interleaves into a URL', () => {
		expect(stripAnsi(`${ESC}[36mhttps://x${ESC}[0m/auth`)).toBe('https://x/auth');
	});
});

describe('AuthLinkDetector', () => {
	it('detects a plainly printed Google OAuth URL once', () => {
		const d = new AuthLinkDetector();
		expect(d.push('Visit https://accounts.google.com/o/oauth2/v2/auth?client_id=abc to continue.\n')).toEqual([
			'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc'
		]);
		// Same URL re-rendered (TUI redraw) does not re-fire.
		expect(d.push('https://accounts.google.com/o/oauth2/v2/auth?client_id=abc')).toEqual([]);
	});

	it('catches a URL split across chunk boundaries', () => {
		const d = new AuthLinkDetector();
		expect(d.push('open https://accounts.google.')).toEqual([]);
		expect(d.push('com/device?user_code=WDQK-XYZ now')).toEqual([
			'https://accounts.google.com/device?user_code=WDQK-XYZ'
		]);
	});

	it('reassembles a URL broken up by ANSI escapes', () => {
		const d = new AuthLinkDetector();
		expect(d.push(`${ESC}[1mhttps://antigravity.google/auth?code=${ESC}[0mZZ123`)).toEqual([
			'https://antigravity.google/auth?code=ZZ123'
		]);
	});

	it('ignores non-auth URLs', () => {
		const d = new AuthLinkDetector();
		expect(d.push('see https://openai.com/index/introducing-gpt-5-5/ for details')).toEqual([]);
	});
});
