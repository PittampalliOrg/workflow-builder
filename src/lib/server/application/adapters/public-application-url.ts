import type { PublicApplicationUrlPort } from "$lib/server/application/ports";
import { getAppUrl } from "$lib/server/app-url";

export class ConfiguredPublicApplicationUrlAdapter
	implements PublicApplicationUrlPort
{
	resolve(input: { request: Request; fallbackUrl: URL }): Promise<string> {
		return getAppUrl(input.fallbackUrl, input.request);
	}
}
