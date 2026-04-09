/**
 * In-memory event bus for sandbox state changes received via Dapr pub/sub.
 *
 * The agent-runtime publishes sandbox events (phase changes, create/delete, snapshots)
 * to NATS JetStream via Dapr. This singleton maintains current sandbox state and
 * notifies SSE subscribers of changes.
 */

import type { Sandbox } from '$lib/types/sandbox';

export type SandboxEventType =
	| 'sandbox_added'
	| 'sandbox_changed'
	| 'sandbox_removed'
	| 'snapshot';

export interface SandboxBusEvent {
	type: SandboxEventType;
	sandbox?: Sandbox;
	sandboxes?: Sandbox[];
	name?: string;
	timestamp: string;
}

type Subscriber = (event: SandboxBusEvent) => void;

class SandboxEventBus {
	private sandboxes = new Map<string, Sandbox>();
	private subscribers = new Set<Subscriber>();
	private seeded = false;

	/** Whether the event bus has received at least one snapshot or event */
	get isSeeded(): boolean {
		return this.seeded;
	}

	/** Current sandbox list */
	getAll(): Sandbox[] {
		return Array.from(this.sandboxes.values());
	}

	/** Get a single sandbox by name */
	get(name: string): Sandbox | undefined {
		return this.sandboxes.get(name);
	}

	/** Subscribe to events. Returns unsubscribe function. */
	subscribe(fn: Subscriber): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	private notify(event: SandboxBusEvent): void {
		for (const fn of this.subscribers) {
			try {
				fn(event);
			} catch {
				// subscriber error — don't propagate
			}
		}
	}

	/** Handle a full snapshot (from sandbox.list_snapshot event) */
	handleSnapshot(sandboxes: Sandbox[]): void {
		const current = new Map(sandboxes.map((s) => [s.name, s]));

		// Detect additions and changes vs existing state
		if (this.seeded) {
			for (const sb of sandboxes) {
				const prev = this.sandboxes.get(sb.name);
				if (!prev) {
					this.notify({ type: 'sandbox_added', sandbox: sb, timestamp: new Date().toISOString() });
				} else if (JSON.stringify(prev) !== JSON.stringify(sb)) {
					this.notify({ type: 'sandbox_changed', sandbox: sb, timestamp: new Date().toISOString() });
				}
			}
			for (const [name] of this.sandboxes) {
				if (!current.has(name)) {
					this.notify({ type: 'sandbox_removed', name, timestamp: new Date().toISOString() });
				}
			}
		}

		this.sandboxes = current;
		this.seeded = true;
		this.notify({
			type: 'snapshot',
			sandboxes,
			timestamp: new Date().toISOString()
		});
	}

	/** Handle a phase change event (from sandbox.phase_changed) */
	handlePhaseChanged(sandboxName: string, phase: string, sandbox: Sandbox | null): void {
		this.seeded = true;

		if (phase === 'DELETED' || !sandbox) {
			if (this.sandboxes.has(sandboxName)) {
				this.sandboxes.delete(sandboxName);
				this.notify({ type: 'sandbox_removed', name: sandboxName, timestamp: new Date().toISOString() });
			}
			return;
		}

		const prev = this.sandboxes.get(sandboxName);
		const updated: Sandbox = {
			name: sandbox.name ?? sandboxName,
			type: sandbox.type ?? 'openshell',
			phase: (phase?.toUpperCase() ?? 'UNKNOWN') as Sandbox['phase'],
			createdAt: sandbox.createdAt,
			image: sandbox.image
		};

		this.sandboxes.set(sandboxName, updated);

		if (!prev) {
			this.notify({ type: 'sandbox_added', sandbox: updated, timestamp: new Date().toISOString() });
		} else {
			this.notify({ type: 'sandbox_changed', sandbox: updated, timestamp: new Date().toISOString() });
		}
	}

	/** Handle sandbox create/delete completion events */
	handleCreateCompleted(sandboxName: string): void {
		// The phase_changed event will carry the actual sandbox data.
		// This just ensures we mark as seeded if we get create events before a snapshot.
		this.seeded = true;
	}

	handleDeleteCompleted(sandboxName: string): void {
		if (this.sandboxes.has(sandboxName)) {
			this.sandboxes.delete(sandboxName);
			this.notify({ type: 'sandbox_removed', name: sandboxName, timestamp: new Date().toISOString() });
		}
	}
}

/** Singleton event bus instance */
export const sandboxEventBus = new SandboxEventBus();
