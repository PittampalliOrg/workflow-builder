import type {
	AdminPieceRuntimeImageBuildPort,
	AdminPieceRuntimeImageRegistryPort,
} from "$lib/server/application/ports";
import {
	ghcrImageExists,
	pieceImageRef,
	triggerPieceImageBuild,
} from "$lib/server/pieces/piece-images";

export class LegacyAdminPieceRuntimeImageRegistryPort
	implements AdminPieceRuntimeImageRegistryPort
{
	imageExists(input: { pieceName: string; version: string }) {
		return ghcrImageExists(input.pieceName, input.version);
	}

	imageRef(input: { pieceName: string; version: string }) {
		return pieceImageRef(input.pieceName, input.version);
	}
}

export class LegacyAdminPieceRuntimeImageBuildPort
	implements AdminPieceRuntimeImageBuildPort
{
	triggerBuild(input: {
		pieceName: string;
		pieceVersion: string;
		callbackUrl: string;
	}) {
		return triggerPieceImageBuild(input);
	}
}
