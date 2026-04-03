import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { pieceMetadata, platformOauthApps } from '$lib/server/db/schema';
import { inArray, desc } from 'drizzle-orm';
import { getAppUrl } from '$lib/server/app-url';
import {
	getOAuth2AuthConfig,
	generatePkceVerifier,
	generatePkceChallenge,
	generateOAuthState,
	buildOAuth2AuthorizationUrl,
	resolveValueFromProps
} from '$lib/server/app-connections/oauth2';

const AP_PREFIX = '@activepieces/piece-';

/** Expand a piece name to both prefixed and unprefixed candidates. */
function expandPieceNameCandidates(name: string): string[] {
	const candidates = new Set([name]);
	if (name.startsWith(AP_PREFIX)) {
		candidates.add(name.slice(AP_PREFIX.length));
	} else {
		candidates.add(`${AP_PREFIX}${name}`);
	}
	return Array.from(candidates);
}

/**
 * POST /api/app-connections/oauth2/start
 *
 * Initiate an OAuth2 authorization flow. Returns the authorization URL,
 * PKCE verifier/challenge, state, and other parameters the client needs
 * to open the OAuth popup and later exchange the code.
 */
export const POST: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.session?.userId) {
		return error(401, 'Unauthorized');
	}
	if (!db) {
		return error(503, 'Database not configured');
	}

	const body = (await request.json()) as {
		pieceName?: string;
		pieceVersion?: string;
		clientId?: string;
		redirectUrl?: string;
		props?: Record<string, unknown>;
	};

	if (!body.pieceName) {
		return error(400, 'pieceName is required');
	}

	// ----- Look up piece metadata -----
	const candidates = expandPieceNameCandidates(body.pieceName);

	const pieces = await db
		.select()
		.from(pieceMetadata)
		.where(inArray(pieceMetadata.name, candidates))
		.orderBy(desc(pieceMetadata.createdAt))
		.limit(5);

	// If a specific version was requested, prefer it; otherwise take the first
	let piece = body.pieceVersion
		? pieces.find((p) => p.version === body.pieceVersion)
		: undefined;
	if (!piece) piece = pieces[0];

	if (!piece) {
		return error(404, 'Piece not found');
	}

	const oauthAuth = getOAuth2AuthConfig(piece);
	if (!oauthAuth?.authUrl) {
		return error(400, 'Piece does not define OAuth2 auth URL');
	}

	// ----- Resolve clientId -----
	let clientId = body.clientId;
	if (!clientId) {
		const oauthAppRows = await db
			.select({ clientId: platformOauthApps.clientId })
			.from(platformOauthApps)
			.where(inArray(platformOauthApps.pieceName, candidates))
			.limit(1);

		if (!oauthAppRows.length) {
			return error(
				400,
				'No OAuth app configured for this piece. Configure it in Settings > OAuth Apps.'
			);
		}
		clientId = oauthAppRows[0].clientId;
	}

	// ----- Resolve redirect URL -----
	const appUrl = await getAppUrl(url, request);
	const redirectUrl = body.redirectUrl || `${appUrl}/redirect`;

	// ----- PKCE -----
	const verifier = generatePkceVerifier();
	const pkceEnabled = oauthAuth.pkce ?? false;
	const pkceMethod = oauthAuth.pkceMethod ?? 'plain';
	const challenge = pkceEnabled
		? pkceMethod === 'S256'
			? generatePkceChallenge(verifier)
			: verifier
		: '';

	const state = generateOAuthState();

	// ----- Build authorization URL -----
	const authUrl = resolveValueFromProps(oauthAuth.authUrl, body.props);
	const scope = (oauthAuth.scope ?? []).map((s) => resolveValueFromProps(s, body.props));
	const extraParams = oauthAuth.extra
		? Object.fromEntries(
				Object.entries(oauthAuth.extra).map(([k, v]) => [
					k,
					resolveValueFromProps(v, body.props)
				])
			)
		: undefined;

	const scopeString = scope.join(' ');
	const authorizationUrl = buildOAuth2AuthorizationUrl({
		authUrl,
		clientId,
		redirectUrl,
		scope,
		state,
		codeChallenge: pkceEnabled ? challenge : undefined,
		codeChallengeMethod: pkceMethod,
		prompt: oauthAuth.prompt,
		extraParams
	});

	return json({
		authorizationUrl,
		clientId,
		state,
		codeVerifier: pkceEnabled ? verifier : '',
		codeChallenge: pkceEnabled ? challenge : '',
		redirectUrl,
		scope: scopeString
	});
};
