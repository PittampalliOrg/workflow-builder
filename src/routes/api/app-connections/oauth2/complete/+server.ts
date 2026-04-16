import { json, error, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { appConnections, pieceMetadata, platformOauthApps } from '$lib/server/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getAppUrl } from '$lib/server/app-url';
import {
	exchangeOAuth2CodePlatform,
	getOAuth2AuthConfig,
	resolveValueFromProps,
	type OAuth2AuthorizationMethod,
} from '$lib/server/app-connections/oauth2';
import {
	decryptString,
	decryptObject,
	encryptObject,
	type EncryptedObject,
} from '$lib/server/security/encryption';
import { AppConnectionStatus, AppConnectionType } from '$lib/server/types/app-connection';
import {
	connectionBelongsToProject,
	mergeConnectionProjectId
} from '$lib/server/app-connection-scope';
import { requireSessionProjectId } from '$lib/server/mcp-connections';

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

function resolveClientSecret(value: unknown): string {
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as EncryptedObject;
			if (parsed && typeof parsed === 'object' && 'iv' in parsed && 'data' in parsed) {
				return decryptString(parsed);
			}
		} catch {
			return value;
		}
		return value;
	}

	if (
		value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		'iv' in value &&
		'data' in value
	) {
		return decryptString(value as EncryptedObject);
	}

	throw new Error('OAuth client secret is not configured correctly');
}

export const POST: RequestHandler = async ({ request, locals, url }) => {
	const projectId = requireSessionProjectId(locals);
	if (!db) {
		return error(503, 'Database not configured');
	}

	const body = (await request.json()) as {
		connectionId?: string;
		pieceName?: string;
		code?: string;
		codeVerifier?: string;
		redirectUrl?: string;
	};

	if (!body.connectionId || !body.pieceName || !body.code) {
		return error(400, 'connectionId, pieceName, and code are required');
	}

	const [connection] = await db
		.select()
		.from(appConnections)
		.where(eq(appConnections.id, body.connectionId))
		.limit(1);

	if (!connection) {
		return error(404, 'Connection not found');
	}
	if (!connectionBelongsToProject(connection.projectIds, projectId)) {
		return error(404, 'Connection not found');
	}

	const connectionValue = decryptObject<Record<string, unknown>>(
		connection.value as EncryptedObject,
	);
	const connectionProps =
		connectionValue.props && typeof connectionValue.props === 'object'
			? (connectionValue.props as Record<string, unknown>)
			: undefined;

	const candidates = expandPieceNameCandidates(body.pieceName);
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
	if (!oauthAuth?.tokenUrl) {
		return error(400, 'Piece does not define OAuth2 token URL');
	}

	const authorizationMethod =
		(typeof connectionValue.authorization_method === 'string'
			? connectionValue.authorization_method
			: oauthAuth.authorizationMethod) as OAuth2AuthorizationMethod | undefined;
	const [oauthApp] = await db
		.select()
		.from(platformOauthApps)
		.where(
			connection.platformId
				? and(
						inArray(platformOauthApps.pieceName, candidates),
						eq(platformOauthApps.platformId, connection.platformId),
					)
				: inArray(platformOauthApps.pieceName, candidates),
		)
		.limit(1);

	if (!oauthApp) {
		return error(
			400,
			'No OAuth app configured for this piece. Configure it in Settings > OAuth Apps.',
		);
	}

	const redirectUrl =
		body.redirectUrl ||
		(typeof connectionValue.redirect_url === 'string' && connectionValue.redirect_url) ||
		`${await getAppUrl(url, request)}/api/app-connections/oauth2/callback`;

	const tokenValue = await exchangeOAuth2CodePlatform({
		code: body.code,
		tokenUrl: resolveValueFromProps(oauthAuth.tokenUrl, connectionProps),
		clientId: oauthApp.clientId,
		clientSecret: resolveClientSecret(oauthApp.clientSecret),
		redirectUrl,
		scope: (oauthAuth.scope ?? [])
			.map((entry) => resolveValueFromProps(entry, connectionProps))
			.join(' '),
		props: connectionProps,
		authorizationMethod,
		codeVerifier: body.codeVerifier,
	});

	const [updated] = await db
		.update(appConnections)
		.set({
			status: AppConnectionStatus.ACTIVE,
			type: AppConnectionType.PLATFORM_OAUTH2,
			value: encryptObject(tokenValue as unknown as Record<string, unknown>),
			pieceName: body.pieceName,
			pieceVersion: piece.version,
			projectIds: mergeConnectionProjectId(connection.projectIds, projectId),
			updatedAt: new Date(),
		})
		.where(eq(appConnections.id, body.connectionId))
		.returning({
			id: appConnections.id,
			externalId: appConnections.externalId,
			pieceName: appConnections.pieceName,
			displayName: appConnections.displayName,
			type: appConnections.type,
			status: appConnections.status,
			createdAt: appConnections.createdAt,
			updatedAt: appConnections.updatedAt,
		});

	return json({
		success: true,
		connection: updated,
	});
};
