import { getContext, setContext } from "svelte";

const REASONING_CONTEXT_KEY = Symbol("reasoning");

class ReasoningContext {
	#isOpen = $state(false);

	get isOpen() {
		return this.#isOpen;
	}

	setOpen(value: boolean) {
		this.#isOpen = value;
	}

	toggle() {
		this.#isOpen = !this.#isOpen;
	}
}

export function setReasoningContext(initialOpen = false): ReasoningContext {
	const context = new ReasoningContext();
	if (initialOpen) context.setOpen(true);
	setContext(REASONING_CONTEXT_KEY, context);
	return context;
}

export function getReasoningContext(): ReasoningContext {
	const context = getContext<ReasoningContext>(REASONING_CONTEXT_KEY);
	if (!context) {
		throw new Error("getReasoningContext must be used within a Reasoning component");
	}
	return context;
}

export { ReasoningContext };
