import type { PromotionStatePort } from "$lib/server/application/ports";
import { getPromotionStrategies, getPromotionStrategy } from "$lib/server/promoter";
import type {
	PromotionStrategiesResponse,
	PromotionStrategy,
} from "$lib/server/promoter/types";

/** Adapter over the legacy `promoter` module (hub-inventory projection +
 * fixture fallback stay in the domain module). */
export class LegacyPromotionStateGateway implements PromotionStatePort {
	getPromotionStrategies(): Promise<PromotionStrategiesResponse> {
		return getPromotionStrategies();
	}

	getPromotionStrategy(name: string): Promise<PromotionStrategy | null> {
		return getPromotionStrategy(name);
	}
}
