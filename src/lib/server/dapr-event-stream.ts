/**
 * Generic Dapr pub/sub event stream for debugging.
 *
 * Captures all pub/sub events received by this app's sidecar and buffers
 * them in a ring buffer for SSE streaming to the Dapr System dashboard.
 */

export interface DaprStreamEvent {
	id: number;
	topic: string;
	type: string;
	source: string;
	data: unknown;
	timestamp: string;
}

type Subscriber = (event: DaprStreamEvent) => void;

const MAX_BUFFER_SIZE = 200;

class DaprEventStream {
	private buffer: DaprStreamEvent[] = [];
	private subscribers = new Set<Subscriber>();
	private nextId = 1;

	/** Push a new event into the stream */
	push(topic: string, type: string, source: string, data: unknown): void {
		const event: DaprStreamEvent = {
			id: this.nextId++,
			topic,
			type,
			source,
			data,
			timestamp: new Date().toISOString()
		};

		this.buffer.push(event);
		if (this.buffer.length > MAX_BUFFER_SIZE) {
			this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
		}

		for (const fn of this.subscribers) {
			try {
				fn(event);
			} catch {
				// subscriber error
			}
		}
	}

	/** Get recent events */
	getRecent(limit: number = 50): DaprStreamEvent[] {
		return this.buffer.slice(-limit);
	}

	/** Subscribe to live events. Returns unsubscribe function. */
	subscribe(fn: Subscriber): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	/** Current buffer size */
	get size(): number {
		return this.buffer.length;
	}
}

export const daprEventStream = new DaprEventStream();
