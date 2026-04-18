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

export {};
