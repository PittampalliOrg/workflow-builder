export type AuthSessionUser = {
	id: string;
	name: string | null;
	email: string;
	image: string | null;
	platformId: string;
	projectId: string;
};

export type AuthSession = {
	user: AuthSessionUser;
};

export type AuthCookieStore = {
	get(name: string): string | undefined;
	set(
		name: string,
		value: string,
		opts: { path: string; [key: string]: unknown },
	): void;
};

export type AuthTokenPair = {
	accessToken: string;
	refreshToken: string;
};

export type AuthAccessTokenPayload = {
	sub: string;
	email?: string;
	platformId?: string;
	projectId?: string;
	tokenVersion?: number;
	type?: "access" | "refresh";
};

export type AuthSessionReader = {
	getSession(input: {
		request: Request;
		cookies?: AuthCookieStore;
	}): Promise<AuthSession | null>;
};

export type AuthTokenRefresher = {
	refreshTokens(refreshToken: string): Promise<AuthTokenPair | null>;
};

export type AuthAccessTokenVerifier = {
	verifyAccessToken(token: string): Promise<AuthAccessTokenPayload | null>;
};

export class ApplicationAuthSessionService {
	constructor(
		private readonly deps: {
			sessions: AuthSessionReader;
			tokens: AuthTokenRefresher;
			accessTokens: AuthAccessTokenVerifier;
		},
	) {}

	getSession(input: {
		request: Request;
		cookies?: AuthCookieStore;
	}): Promise<AuthSession | null> {
		return this.deps.sessions.getSession(input);
	}

	refreshTokens(input: {
		refreshToken: string | null | undefined;
	}): Promise<AuthTokenPair | null> {
		const refreshToken = input.refreshToken?.trim();
		if (!refreshToken) return Promise.resolve(null);
		return this.deps.tokens.refreshTokens(refreshToken);
	}

	verifyAccessToken(input: {
		token: string | null | undefined;
	}): Promise<AuthAccessTokenPayload | null> {
		const token = input.token?.trim();
		if (!token) return Promise.resolve(null);
		return this.deps.accessTokens.verifyAccessToken(token);
	}
}
