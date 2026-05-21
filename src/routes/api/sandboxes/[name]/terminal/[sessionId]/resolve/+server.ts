import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

function validateTerminalId(terminalId: string): void {
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(terminalId)) {
		error(400, 'Invalid terminal id');
	}
}

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.session) error(401, 'Unauthorized');
	validateTerminalId(params.sessionId);

	return json({
		sandboxName: params.name,
		terminalId: params.sessionId,
	});
};
