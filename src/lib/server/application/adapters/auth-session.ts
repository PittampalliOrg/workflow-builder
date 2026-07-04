import {
	getSession,
	refreshTokens,
} from "$lib/server/auth";
import type {
	AuthCookieStore,
	AuthSessionReader,
	AuthTokenRefresher,
} from "$lib/server/application/auth-session";

export class LegacyAuthSessionReader implements AuthSessionReader {
	getSession(input: { request: Request; cookies?: AuthCookieStore }) {
		return getSession(input.request, input.cookies);
	}
}

export class LegacyAuthTokenRefresher implements AuthTokenRefresher {
	refreshTokens(refreshToken: string) {
		return refreshTokens(refreshToken);
	}
}
