/**
 * Drizzle ORM Storage Driver
 * Persistent, transactional PostgreSQL adapter using Drizzle ORM
 */

import { and, eq, isNull } from 'drizzle-orm';
import {
  ISlaPolicy,
  ISlaStorageDriver,
  ISlaTracker,
  ISlaTrackerWithPolicy,
  SlaStatus,
  SlaTriggerEvent,
} from '../../interfaces';
import { slaPolicies, slaTrackers } from './schema';

export interface IDrizzleDb {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
}

export class DrizzleSlaStorage implements ISlaStorageDriver {
  private readonly db: any;

  constructor(drizzleDbInstance: any) {
    this.db = drizzleDbInstance;
  }

  private getExecutor(tx?: unknown): any {
    return (tx as any) ?? this.db;
  }

  public async findActivePoliciesByTrigger(
    triggerEvent: SlaTriggerEvent,
    entityType?: string,
    scopeId?: string,
    tx?: unknown
  ): Promise<ISlaPolicy[]> {
    const executor = this.getExecutor(tx);
    const conditions = [
      eq(slaPolicies.isActive, true),
      isNull(slaPolicies.deletedAt),
      eq(slaPolicies.triggerEvent, triggerEvent),
    ];

    if (entityType) {
      conditions.push(eq(slaPolicies.entityType, entityType));
    }
    if (scopeId) {
      conditions.push(eq(slaPolicies.scopeId, scopeId));
    }

    const rows = await executor
      .select()
      .from(slaPolicies)
      .where(and(...conditions));

    return rows.map((r: any) => this.mapPolicy(r));
  }

  public async findActiveTrackersByEntity(
    entityId: string,
    entityType?: string,
    tx?: unknown
  ): Promise<ISlaTrackerWithPolicy[]> {
    const executor = this.getExecutor(tx);
    const conditions = [
      eq(slaTrackers.entityId, entityId),
      eq(slaTrackers.status, 'ACTIVE'),
    ];

    if (entityType) {
      conditions.push(eq(slaTrackers.entityType, entityType));
    }

    const rows = await executor
      .select({
        tracker: slaTrackers,
        policy: slaPolicies,
      })
      .from(slaTrackers)
      .innerJoin(slaPolicies, eq(slaTrackers.policyId, slaPolicies.id))
      .where(and(...conditions));

    return rows.map(({ tracker, policy }: any) => ({
      ...this.mapTracker(tracker),
      policy: {
        id: policy.id,
        name: policy.name,
        triggerEvent: policy.triggerEvent,
        stopEvent: policy.stopEvent,
        targetScopeId: policy.targetScopeId,
        conditionPayload: policy.conditionPayload,
        targetMinutes: policy.targetMinutes,
      },
    }));
  }

  public async findExistingActiveTracker(
    policyId: string,
    entityId: string,
    tx?: unknown
  ): Promise<ISlaTracker | null> {
    const executor = this.getExecutor(tx);
    const rows = await executor
      .select()
      .from(slaTrackers)
      .where(
        and(
          eq(slaTrackers.policyId, policyId),
          eq(slaTrackers.entityId, entityId),
          eq(slaTrackers.status, 'ACTIVE')
        )
      )
      .limit(1);

    return rows.length > 0 ? this.mapTracker(rows[0]) : null;
  }

  public async createTracker(
    tracker: Omit<ISlaTracker, 'id' | 'createdAt' | 'updatedAt'>,
    tx?: unknown
  ): Promise<ISlaTracker> {
    const executor = this.getExecutor(tx);
    const [created] = await executor
      .insert(slaTrackers)
      .values({
        policyId: tracker.policyId,
        entityId: tracker.entityId,
        entityType: tracker.entityType,
        status: tracker.status,
        startedAt: tracker.startedAt,
        targetAt: tracker.targetAt,
        metadata: tracker.metadata,
      })
      .returning();

    return this.mapTracker(created);
  }

  public async updateTrackerStatus(
    trackerId: string,
    status: SlaStatus,
    stoppedAt: Date,
    metadata?: Record<string, unknown>,
    tx?: unknown
  ): Promise<ISlaTracker> {
    const executor = this.getExecutor(tx);
    const [updated] = await executor
      .update(slaTrackers)
      .set({
        status,
        stoppedAt,
        metadata,
        updatedAt: new Date(),
      })
      .where(eq(slaTrackers.id, trackerId))
      .returning();

    if (!updated) {
      throw new Error(`Failed to update tracker ${trackerId}: Not found`);
    }

    return this.mapTracker(updated);
  }

  public async findPolicies(
    filter?: { isActive?: boolean; entityType?: string },
    tx?: unknown
  ): Promise<ISlaPolicy[]> {
    const executor = this.getExecutor(tx);
    const conditions = [isNull(slaPolicies.deletedAt)];

    if (filter?.isActive !== undefined) {
      conditions.push(eq(slaPolicies.isActive, filter.isActive));
    }
    if (filter?.entityType !== undefined) {
      conditions.push(eq(slaPolicies.entityType, filter.entityType));
    }

    const rows = await executor
      .select()
      .from(slaPolicies)
      .where(and(...conditions));

    return rows.map((r: any) => this.mapPolicy(r));
  }

  public async createPolicy(
    policy: Omit<ISlaPolicy, 'id' | 'createdAt' | 'updatedAt'>,
    tx?: unknown
  ): Promise<ISlaPolicy> {
    const executor = this.getExecutor(tx);
    const [created] = await executor
      .insert(slaPolicies)
      .values({
        name: policy.name,
        description: policy.description,
        entityType: policy.entityType,
        scopeId: policy.scopeId,
        targetScopeId: policy.targetScopeId,
        triggerEvent: policy.triggerEvent,
        stopEvent: policy.stopEvent,
        targetMinutes: policy.targetMinutes,
        conditionPayload: policy.conditionPayload,
        isActive: policy.isActive ?? true,
      })
      .returning();

    return this.mapPolicy(created);
  }

  public async updatePolicy(
    id: string,
    patch: Partial<ISlaPolicy>,
    tx?: unknown
  ): Promise<ISlaPolicy> {
    const executor = this.getExecutor(tx);
    const [updated] = await executor
      .update(slaPolicies)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(slaPolicies.id, id))
      .returning();

    if (!updated) {
      throw new Error(`SLA Policy ${id} not found.`);
    }

    return this.mapPolicy(updated);
  }

  private mapPolicy(row: any): ISlaPolicy {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      entityType: row.entityType,
      scopeId: row.scopeId,
      targetScopeId: row.targetScopeId,
      triggerEvent: row.triggerEvent,
      stopEvent: row.stopEvent,
      targetMinutes: Number(row.targetMinutes),
      conditionPayload: row.conditionPayload,
      isActive: Boolean(row.isActive),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
    };
  }

  private mapTracker(row: any): ISlaTracker {
    return {
      id: row.id,
      policyId: row.policyId,
      entityId: row.entityId,
      entityType: row.entityType,
      status: row.status as SlaStatus,
      startedAt: new Date(row.startedAt),
      targetAt: new Date(row.targetAt),
      stoppedAt: row.stoppedAt ? new Date(row.stoppedAt) : null,
      metadata: row.metadata,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }
}
