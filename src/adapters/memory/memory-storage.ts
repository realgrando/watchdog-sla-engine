/**
 * In-Memory SLA Storage Driver
 * Thread-safe, non-blocking storage adapter for local testing, CI/CD, and serverless environments.
 */

import {
  ISlaPolicy,
  ISlaStorageDriver,
  ISlaTracker,
  ISlaTrackerWithPolicy,
  SlaStatus,
  SlaTriggerEvent,
} from '../../interfaces';

export class InMemorySlaStorage implements ISlaStorageDriver {
  private readonly policies = new Map<string, ISlaPolicy>();
  private readonly trackers = new Map<string, ISlaTracker>();

  public async findActivePoliciesByTrigger(
    triggerEvent: SlaTriggerEvent,
    entityType?: string,
    scopeId?: string
  ): Promise<ISlaPolicy[]> {
    return Array.from(this.policies.values()).filter((policy) => {
      if (!policy.isActive || policy.deletedAt) return false;
      if (policy.triggerEvent !== triggerEvent) return false;
      if (entityType && policy.entityType && policy.entityType !== entityType) {
        return false;
      }
      if (scopeId && policy.scopeId && policy.scopeId !== scopeId) {
        return false;
      }
      return true;
    });
  }

  public async findActiveTrackersByEntity(
    entityId: string,
    entityType?: string
  ): Promise<ISlaTrackerWithPolicy[]> {
    const active = Array.from(this.trackers.values()).filter((tracker) => {
      if (tracker.entityId !== entityId) return false;
      if (tracker.status !== 'ACTIVE') return false;
      if (entityType && tracker.entityType && tracker.entityType !== entityType) {
        return false;
      }
      return true;
    });

    const result: ISlaTrackerWithPolicy[] = [];
    for (const tracker of active) {
      const policy = this.policies.get(tracker.policyId);
      if (!policy) continue;
      result.push({
        ...tracker,
        policy: {
          id: policy.id,
          name: policy.name,
          triggerEvent: policy.triggerEvent,
          stopEvent: policy.stopEvent,
          targetScopeId: policy.targetScopeId,
          conditionPayload: policy.conditionPayload,
          targetMinutes: policy.targetMinutes,
        },
      });
    }

    return result;
  }

  public async findExistingActiveTracker(
    policyId: string,
    entityId: string
  ): Promise<ISlaTracker | null> {
    const existing = Array.from(this.trackers.values()).find(
      (t) =>
        t.policyId === policyId &&
        t.entityId === entityId &&
        t.status === 'ACTIVE'
    );
    return existing ?? null;
  }

  public async createTracker(
    tracker: Omit<ISlaTracker, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ISlaTracker> {
    const id = this.generateId();
    const now = new Date();
    const created: ISlaTracker = {
      ...tracker,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.trackers.set(id, created);
    return created;
  }

  public async updateTrackerStatus(
    trackerId: string,
    status: SlaStatus,
    stoppedAt: Date,
    metadata?: Record<string, unknown>
  ): Promise<ISlaTracker> {
    const existing = this.trackers.get(trackerId);
    if (!existing) {
      throw new Error(`Tracker with ID "${trackerId}" not found in memory store.`);
    }

    const updated: ISlaTracker = {
      ...existing,
      status,
      stoppedAt,
      metadata: metadata ? { ...existing.metadata, ...metadata } : existing.metadata,
      updatedAt: new Date(),
    };

    this.trackers.set(trackerId, updated);
    return updated;
  }

  public async findPolicies(filter?: {
    isActive?: boolean;
    entityType?: string;
  }): Promise<ISlaPolicy[]> {
    return Array.from(this.policies.values()).filter((p) => {
      if (p.deletedAt) return false;
      if (filter?.isActive !== undefined && p.isActive !== filter.isActive) {
        return false;
      }
      if (
        filter?.entityType !== undefined &&
        p.entityType !== filter.entityType
      ) {
        return false;
      }
      return true;
    });
  }

  public async createPolicy(
    policy: Omit<ISlaPolicy, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ISlaPolicy> {
    const id = this.generateId();
    const now = new Date();
    const created: ISlaPolicy = {
      ...policy,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.policies.set(id, created);
    return created;
  }

  public async updatePolicy(
    id: string,
    patch: Partial<ISlaPolicy>
  ): Promise<ISlaPolicy> {
    const existing = this.policies.get(id);
    if (!existing) {
      throw new Error(`Policy with ID "${id}" not found in memory store.`);
    }

    const updated: ISlaPolicy = {
      ...existing,
      ...patch,
      updatedAt: new Date(),
    };

    this.policies.set(id, updated);
    return updated;
  }

  public clear(): void {
    this.policies.clear();
    this.trackers.clear();
  }

  private generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
