/**
 * Agent registry — register/discover/list team agents.
 * Mirrors Python DaprInfra registry methods at components.py:459-665.
 */

import { DaprClient } from "@dapr/dapr";
import { withEtagRetry } from "../state/etag-retry.js";
import type { AgentRegistryEntry } from "../pubsub/direct-messaging.js";

const REGISTRY_PREFIX = "agents:";

export class AgentRegistry {
  private client: DaprClient;
  private storeName: string;
  private teamName: string;
  private maxEtagAttempts: number;

  constructor(
    client: DaprClient,
    storeName: string,
    teamName: string = "default",
    maxEtagAttempts: number = 10,
  ) {
    this.client = client;
    this.storeName = storeName;
    this.teamName = teamName;
    this.maxEtagAttempts = maxEtagAttempts;
  }

  private get registryKey(): string {
    return `${REGISTRY_PREFIX}${this.teamName}`;
  }

  /**
   * Register or update agent metadata in the team registry.
   * Mirrors Python register_agentic_system at components.py:459-514.
   */
  async registerAgent(
    agentName: string,
    metadata: AgentRegistryEntry,
  ): Promise<void> {
    await this.mutateRegistry((current) => {
      if (
        JSON.stringify(current[agentName]) === JSON.stringify(metadata)
      ) {
        return null; // No change needed
      }
      current[agentName] = metadata;
      return current;
    });
    console.log(
      `[registry] Registered '${agentName}' in team '${this.teamName}'`,
    );
  }

  /**
   * Remove agent from the team registry.
   * Mirrors Python deregister_agentic_system at components.py:516-525.
   */
  async deregisterAgent(agentName: string): Promise<void> {
    await this.mutateRegistry((current) => {
      if (!(agentName in current)) {
        return null;
      }
      delete current[agentName];
      return current;
    });
    console.log(
      `[registry] Deregistered '${agentName}' from team '${this.teamName}'`,
    );
  }

  /**
   * Load agents metadata for the team.
   * Mirrors Python get_agents_metadata at components.py:527-571.
   */
  async getAgentsMetadata(options?: {
    excludeSelf?: string;
    excludeOrchestrator?: boolean;
  }): Promise<Record<string, AgentRegistryEntry>> {
    const raw = await this.client.state.get(
      this.storeName,
      this.registryKey,
    );
    if (!raw || typeof raw !== "object") {
      return {};
    }

    const agents = raw as Record<string, AgentRegistryEntry>;
    const filtered: Record<string, AgentRegistryEntry> = {};

    for (const [name, meta] of Object.entries(agents)) {
      if (options?.excludeSelf && name === options.excludeSelf) continue;
      if (
        options?.excludeOrchestrator &&
        (meta as any).orchestrator === true
      )
        continue;
      filtered[name] = meta;
    }

    return filtered;
  }

  /**
   * List team agents (excludes self by default).
   * Convenience wrapper for orchestration workflows.
   */
  async listTeamAgents(
    selfName: string,
    includeSelf: boolean = false,
  ): Promise<Record<string, AgentRegistryEntry>> {
    return this.getAgentsMetadata({
      excludeSelf: includeSelf ? undefined : selfName,
    });
  }

  /**
   * Apply a mutation to the registry with optimistic concurrency.
   * Mirrors Python _mutate_registry_entry at components.py:573-638.
   */
  private async mutateRegistry(
    mutator: (
      current: Record<string, AgentRegistryEntry>,
    ) => Record<string, AgentRegistryEntry> | null,
  ): Promise<void> {
    await withEtagRetry(async () => {
      const raw = await this.client.state.get(
        this.storeName,
        this.registryKey,
      );
      const current =
        raw && typeof raw === "object"
          ? (raw as Record<string, AgentRegistryEntry>)
          : {};

      const updated = mutator({ ...current });
      if (updated === null) return; // No change

      await this.client.state.save(this.storeName, [
        { key: this.registryKey, value: updated },
      ]);
    }, this.maxEtagAttempts);
  }
}
