export type RuntimeHandoffMode = 'deployed' | 'live-sync';

/** Stable, non-secret identity for the server currently answering this origin. */
export type RuntimeHandoffIdentity = Readonly<{
	watch: boolean;
	previewName: string | null;
	mode: RuntimeHandoffMode;
	generation: string;
}>;
