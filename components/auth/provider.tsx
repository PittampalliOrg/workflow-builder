"use client";

import type { ReactNode } from "react";
import type { Session } from "@/lib/auth-helpers";
import { seedSession } from "@/lib/auth-client";

export function AuthProvider({
	children,
	initialSession = null,
}: {
	children: ReactNode;
	initialSession?: Session | null;
}) {
	// No automatic session creation - let users browse anonymously
	// Anonymous sessions will be created on-demand when needed
	seedSession(initialSession);
	return <>{children}</>;
}
