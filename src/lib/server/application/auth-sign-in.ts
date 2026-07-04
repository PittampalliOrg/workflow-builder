import { scryptSync } from "node:crypto";

export type SocialAuthProvider = "GITHUB" | "GOOGLE";

export type PasswordSignInResult =
	| {
			ok: false;
			status: number;
			message: string;
	  }
	| {
			ok: true;
			accessToken: string;
			refreshToken: string;
			user: {
				id: string;
				email: string | null;
				name: string | null;
				image: string | null;
			};
	  };

export type SocialProfile = {
	email: string;
	name: string | null;
	image: string | null;
	provider: SocialAuthProvider;
};

export type AuthResult = {
	accessToken: string;
	refreshToken: string;
	user: {
		id: string;
		email: string;
		name: string | null;
		image: string | null;
		projectSlug: string;
	};
};

export type AuthUserRecord = {
	id: string;
	email: string | null;
	name: string | null;
	image: string | null;
	platformId: string | null;
};

export type AuthIdentityRecord = {
	password: string | null;
	tokenVersion: number;
};

export type AuthPlatformRecord = {
	id: string;
};

export type AuthProjectRecord = {
	id: string;
};

export type AuthSocialIdentityInput = {
	userId: string;
	email: string;
	provider: SocialAuthProvider;
	firstName: string | null;
	lastName: string | null;
};

export type AuthUserCreateInput = {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	platformId: string;
};

export type AuthSignInRepository = {
	isAvailable(): boolean;
	findUserByEmail(email: string): Promise<AuthUserRecord | null>;
	findIdentityByUserId(userId: string): Promise<AuthIdentityRecord | null>;
	updateUserImage(userId: string, image: string): Promise<void>;
	createSocialIdentity(input: AuthSocialIdentityInput): Promise<void>;
	createUser(input: AuthUserCreateInput): Promise<void>;
	findAnyPlatform(): Promise<AuthPlatformRecord | null>;
	getPlatformById(platformId: string): Promise<AuthPlatformRecord | null>;
	findProjectByOwnerId(userId: string): Promise<AuthProjectRecord | null>;
	getOrCreateDefaultPlatform(): Promise<AuthPlatformRecord>;
	getOrCreateDefaultProject(
		userId: string,
		platformId: string,
	): Promise<AuthProjectRecord>;
	getIdentityTokenVersion(userId: string): Promise<number>;
};

export type AuthTokenIssuer = {
	issue(input: {
		userId: string;
		email: string;
		platformId: string;
		projectId: string;
		tokenVersion: number;
	}): Promise<{ accessToken: string; refreshToken: string }>;
};

export type AuthIdGenerator = {
	generate(): string;
};

export class ApplicationAuthSignInService {
	constructor(
		private readonly deps: {
			repository: AuthSignInRepository;
			tokens: AuthTokenIssuer;
			ids: AuthIdGenerator;
		},
	) {}

	async signInWithPassword(
		body: Record<string, unknown>,
	): Promise<PasswordSignInResult> {
		const email = typeof body.email === "string" ? body.email.trim() : "";
		const password = typeof body.password === "string" ? body.password : "";
		if (!email || !password) {
			return {
				ok: false,
				status: 400,
				message: "Email and password are required",
			};
		}

		if (!this.deps.repository.isAvailable()) {
			return { ok: false, status: 503, message: "Database not configured" };
		}

		const user = await this.deps.repository.findUserByEmail(email);
		if (!user) return invalidCredentials();

		const identity = await this.deps.repository.findIdentityByUserId(user.id);
		if (!identity?.password) return invalidCredentials();

		const valid = await verifyPassword(password, identity.password);
		if (!valid) return invalidCredentials();

		const platformId =
			user.platformId || (await this.deps.repository.findAnyPlatform())?.id;
		if (!platformId) {
			return { ok: false, status: 500, message: "Platform not configured" };
		}

		const projectId =
			(await this.deps.repository.findProjectByOwnerId(user.id))?.id ||
			"default";

		try {
			const tokens = await this.deps.tokens.issue({
				userId: user.id,
				email: user.email ?? email,
				platformId,
				projectId,
				tokenVersion: identity.tokenVersion,
			});
			return {
				ok: true,
				...tokens,
				user: {
					id: user.id,
					email: user.email,
					name: user.name,
					image: user.image,
				},
			};
		} catch {
			return {
				ok: false,
				status: 500,
				message: "JWT signing key not configured",
			};
		}
	}

	async signInSocial(profile: SocialProfile): Promise<AuthResult> {
		if (!this.deps.repository.isAvailable()) {
			throw new Error("Database not configured");
		}

		const existingUser = await this.deps.repository.findUserByEmail(profile.email);
		let userId: string;
		let userName: string | null;
		let userImage: string | null;
		let platformId: string | null = null;

		if (existingUser) {
			userId = existingUser.id;
			userName = existingUser.name;
			userImage = existingUser.image;
			platformId = existingUser.platformId;

			if (profile.image && !existingUser.image) {
				await this.deps.repository.updateUserImage(userId, profile.image);
				userImage = profile.image;
			}

			const existingIdentity =
				await this.deps.repository.findIdentityByUserId(userId);
			if (!existingIdentity) {
				await this.deps.repository.createSocialIdentity(
					socialIdentityInput(userId, profile),
				);
			}
		} else {
			userId = this.deps.ids.generate();
			userName = profile.name;
			userImage = profile.image;
			const platform = await this.deps.repository.getOrCreateDefaultPlatform();
			platformId = platform.id;

			await this.deps.repository.createUser({
				id: userId,
				name: profile.name,
				email: profile.email,
				image: profile.image,
				platformId: platform.id,
			});
			await this.deps.repository.createSocialIdentity(
				socialIdentityInput(userId, profile),
			);
			await this.deps.repository.getOrCreateDefaultProject(userId, platform.id);
		}

		let platform = platformId
			? await this.deps.repository.getPlatformById(platformId)
			: null;
		if (!platform) {
			platform = await this.deps.repository.getOrCreateDefaultPlatform();
		}
		const project = await this.deps.repository.getOrCreateDefaultProject(
			userId,
			platform.id,
		);
		const tokenVersion = await this.deps.repository.getIdentityTokenVersion(userId);
		const tokens = await this.deps.tokens.issue({
			userId,
			email: profile.email,
			platformId: platform.id,
			projectId: project.id,
			tokenVersion,
		});

		return {
			...tokens,
			user: {
				id: userId,
				email: profile.email,
				name: userName,
				image: userImage,
				projectSlug: "default",
			},
		};
	}
}

async function verifyPassword(
	password: string,
	storedPassword: string,
): Promise<boolean> {
	const bcrypt = await import("bcryptjs");
	try {
		if (await bcrypt.compare(password, storedPassword)) return true;
	} catch {
		// Fall through to the legacy scrypt verifier below.
	}
	if (!storedPassword.includes(":")) return false;
	try {
		const [salt, storedHash] = storedPassword.split(":");
		const derivedHash = scryptSync(password, salt, 64).toString("hex");
		return derivedHash === storedHash;
	} catch {
		return false;
	}
}

function socialIdentityInput(
	userId: string,
	profile: SocialProfile,
): AuthSocialIdentityInput {
	return {
		userId,
		email: profile.email,
		provider: profile.provider,
		firstName: profile.name?.split(" ")[0] || null,
		lastName: profile.name?.split(" ").slice(1).join(" ") || null,
	};
}

function invalidCredentials(): PasswordSignInResult {
	return { ok: false, status: 400, message: "Invalid email or password" };
}
