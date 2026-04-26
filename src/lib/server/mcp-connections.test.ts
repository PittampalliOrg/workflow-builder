import { describe, expect, it } from 'vitest';
import {
	humanizePieceName,
	normalizePieceName,
	pieceCandidates,
	pieceMcpRegistryRef,
	pieceMcpServerUrl,
	normalizePieceMcpServerUrl
} from './mcp-connections';

describe('mcp connection helpers', () => {
	it('normalizes Activepieces piece names for MCP rows', () => {
		expect(normalizePieceName('@activepieces/piece-microsoft-excel-365')).toBe(
			'microsoft-excel-365'
		);
		expect(normalizePieceName(' Microsoft Excel 365 ')).toBe('microsoft-excel-365');
	});

	it('derives the Nimble piece MCP service identity', () => {
		expect(pieceMcpRegistryRef('microsoft-excel-365')).toBe('ap-microsoft-excel-365-service');
		expect(pieceMcpServerUrl('@activepieces/piece-microsoft-excel-365')).toBe(
			'http://ap-microsoft-excel-365-service/mcp'
		);
		expect(normalizePieceMcpServerUrl('http://ap-microsoft-excel-365-service:3100/mcp')).toBe(
			'http://ap-microsoft-excel-365-service/mcp'
		);
	});

	it('matches stored app connection piece-name variants', () => {
		expect(pieceCandidates('microsoft-excel-365')).toEqual([
			'microsoft-excel-365',
			'@activepieces/piece-microsoft-excel-365'
		]);
	});

	it('humanizes a normalized piece name for fallback display', () => {
		expect(humanizePieceName('microsoft-excel-365')).toBe('Microsoft Excel 365');
	});
});
