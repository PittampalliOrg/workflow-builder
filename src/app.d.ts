// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Error {
			message: string;
			code?: string;
		}
		interface Locals {
			session: {
				userId: string;
				email: string;
				projectId: string;
				platformId: string;
			} | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

// Vite raw-import of the goal-loop prompt templates (see
// src/lib/server/goals/render.ts). Lets us keep the codex prompt ports as
// verbatim .md files while bundling their contents into the server build.
declare module "*.md?raw" {
	const content: string;
	export default content;
}

export {};
