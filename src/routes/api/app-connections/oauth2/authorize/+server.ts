import { error, redirect, type RequestHandler } from '@sveltejs/kit';
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
	resolveValueFromProps,
} from '$lib/server/app-connections/oauth2';

const AP_PREFIX = '@activepieces/piece-';

function expandPieceNameCandidates(name: string): string[] {
	const candidates = new Set([name]);
	if (name.startsWith(AP_PREFIX)) {
		candidates.add(name.slice(AP_PREFIX.length));
	} else {
		candidates.add(`${AP_PREFIX}${name}`);
	}
	return Array.from(candidates);
}

export const GET: RequestHandler = async ({ url, locals, request }) => {
	if (!locals.session?.userId) {
		return error(401, 'Unauthorized');
	}
	if (!db) {
		return error(503, 'Database not configured');
	}

	const pieceName = url.searchParams.get('pieceName')?.trim();
	if (!pieceName) {
		return error(400, 'pieceName is required');
	}

	const candidates = expandPieceNameCandidates(pieceName);
	const pieces = await db
		.select()
		.from(pieceMetadata)
		.where(inArray(pieceMetadata.name, candidates))
		.orderBy(desc(pieceMetadata.createdAt))
		.limit(5);

	const piece = pieces[0];
	if (!piece) {
		return error(404, 'Piece not found');
	}

	const oauthAuth = getOAuth2AuthConfig(piece);
	if (!oauthAuth?.authUrl) {
		return error(400, 'Piece does not define OAuth2 auth URL');
	}

	const oauthAppRows = await db
		.select({ clientId: platformOauthApps.clientId })
		.from(platformOauthApps)
		.where(inArray(platformOauthApps.pieceName, candidates))
		.limit(1);

	if (!oauthAppRows.length) {
		return error(
			400,
			'No OAuth app configured for this piece. Configure it in Settings > OAuth Apps.',
		);
	}

	const clientId = oauthAppRows[0].clientId;
	const appUrl = await getAppUrl(url, request);
	const redirectUrl = `${appUrl}/api/app-connections/oauth2/callback`;
	const verifier = generatePkceVerifier();
	const pkceEnabled = oauthAuth.pkce ?? false;
	const pkceMethod = oauthAuth.pkceMethod ?? 'plain';
	const challenge = pkceEnabled
		? pkceMethod === 'S256'
			? generatePkceChallenge(verifier)
			: verifier
		: '';
	const state = generateOAuthState();

	const authUrl = resolveValueFromProps(oauthAuth.authUrl, undefined);
	const scope = (oauthAuth.scope ?? []).map((entry) =>
		resolveValueFromProps(entry, undefined),
	);
	const extraParams = oauthAuth.extra
		? Object.fromEntries(
				Object.entries(oauthAuth.extra).map(([key, value]) => [
					key,
					resolveValueFromProps(value, undefined),
				]),
			)
		: undefined;

	const authorizationUrl = buildOAuth2AuthorizationUrl({
		authUrl,
		clientId,
		redirectUrl,
		scope,
		state,
		codeChallenge: pkceEnabled ? challenge : undefined,
		codeChallengeMethod: pkceMethod,
		prompt: oauthAuth.prompt,
		extraParams,
	});

	throw redirect(302, authorizationUrl);
};
