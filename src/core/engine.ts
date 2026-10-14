/**
 * Watchdog SLA Engine - Core Engine
 * Deterministic, event-driven SLA policy evaluator and state machine
 */

import {
  ISlaAuditSink,
  ISlaEngineOptions,
  ISlaPolicy,
  ISlaStorageDriver,
  ISlaTracker,
  SlaStatus,
  StopEvaluationParams,
  StopEvaluationResult,
  TriggerEvaluationParams,
  TriggerEvaluationResult,
} from '../interfaces';
import { ConditionEvaluator } from './evaluator';

export class WatchdogSlaEngine {
  private readonly storageDriver: ISlaStorageDriver;
  private readonly auditSink?: ISlaAuditSink;
  private readonly clockDriftToleranceMs: number;
  private readonly nowProvider: () => Date;

  private readonly inFlightTrackerLocks = new Set<string>();

  constructor(options: ISlaEngineOptions) {
    this.storageDriver = options.storageDriver;
    this.auditSink = options.auditSink;
    this.clockDriftToleranceMs = options.clockDriftToleranceMs ?? 0;
    this.nowProvider = options.nowProvider ?? (() => new Date());
  }

  /**
   * Evaluates active SLA policies against a trigger event and initiates trackers.
   * Ensures idempotency: duplicate triggers for the same entity and policy are ignored.
   */
  public async evaluateTriggers(
    params: TriggerEvaluationParams,
    tx?: unknown
  ): Promise<TriggerEvaluationResult> {
    const policies = await this.storageDriver.findActivePoliciesByTrigger(
      params.triggerEvent,
      params.entityType,
      params.scopeId,
      tx
    );

    const startedTrackers: ISlaTracker[] = [];
    let skippedDueToDuplication = 0;
    const now = this.nowProvider();

    for (const policy of policies) {
      // 1. Strict Scope Verification
      if (policy.scopeId && params.scopeId && policy.scopeId !== params.scopeId) {
        continue;
      }

      // 2. Dynamic Condition Matching
      if (
        !ConditionEvaluator.matches(
          policy.conditionPayload,
          params.metadata
        )
      ) {
        continue;
      }

      // 3. Concurrency & Idempotency Barrier: Atomic in-flight locking
      const lockKey = `${policy.id}:${params.entityId}`;
      if (this.inFlightTrackerLocks.has(lockKey)) {
        skippedDueToDuplication++;
        continue;
      }
      this.inFlightTrackerLocks.add(lockKey);

      try {
        const existing = await this.storageDriver.findExistingActiveTracker(
          policy.id,
          params.entityId,
          tx
        );

        if (existing) {
          skippedDueToDuplication++;
          continue;
        }

        // 4. Compute deterministic target deadline
        const durationMinutes =
          params.overrideTargetMinutes ?? policy.targetMinutes;
        const targetAt = new Date(now.getTime() + durationMinutes * 60 * 1000);

        // 5. Persist Tracker
        const newTracker = await this.storageDriver.createTracker(
          {
            policyId: policy.id,
            entityId: params.entityId,
            entityType: params.entityType ?? policy.entityType,
            status: 'ACTIVE',
            startedAt: now,
            targetAt,
            metadata: params.metadata ?? null,
          },
          tx
        );

        startedTrackers.push(newTracker);

        // 6. Dispatch Audit Sink Event
        if (this.auditSink) {
          await this.auditSink.onTrackerStarted({
            trackerId: newTracker.id,
            policyId: policy.id,
            policyName: policy.name,
            entityId: params.entityId,
            entityType: newTracker.entityType,
            targetMinutes: durationMinutes,
            targetAt,
            startedAt: now,
            metadata: params.metadata,
          });
        }
      } finally {
        this.inFlightTrackerLocks.delete(lockKey);
      }
    }

    return {
      evaluatedPoliciesCount: policies.length,
      startedTrackers,
      skippedDueToDuplicationCount: skippedDueToDuplication,
    };
  }

  /**
   * Evaluates active trackers for an entity and halts them if the stop event matches.
   * Classifies final status as MET or BREACHED based on deterministic time boundaries.
   */
  public async evaluateStops(
    params: StopEvaluationParams,
    tx?: unknown
  ): Promise<StopEvaluationResult> {
    const activeTrackers =
      await this.storageDriver.findActiveTrackersByEntity(
        params.entityId,
        params.entityType,
        tx
      );

    const resolvedTrackers: StopEvaluationResult['resolvedTrackers'] = [];
    const now = this.nowProvider();

    for (const tracker of activeTrackers) {
      if (tracker.policy.stopEvent !== params.stopEvent) {
        continue;
      }

      // 1. Target Scope Check (e.g. specific stop lane/stage)
      if (
        tracker.policy.targetScopeId &&
        params.scopeId &&
        tracker.policy.targetScopeId !== params.scopeId
      ) {
        continue;
      }

      // 2. Dynamic Condition Evaluation
      if (
        !ConditionEvaluator.matches(
          tracker.policy.conditionPayload,
          params.metadata
        )
      ) {
        continue;
      }

      // 3. Deterministic Breach Evaluation
      const isBreached =
        now.getTime() > tracker.targetAt.getTime() + this.clockDriftToleranceMs;
      const finalStatus: SlaStatus = isBreached ? 'BREACHED' : 'MET';

      // 4. Update Tracker State in Storage
      const updated = await this.storageDriver.updateTrackerStatus(
        tracker.id,
        finalStatus,
        now,
        params.metadata,
        tx
      );

      // 5. Compute Duration Telemetry
      const durationMs = Math.max(0, now.getTime() - tracker.startedAt.getTime());
      const durationMinutes = Math.floor(durationMs / 60000);
      const durationSeconds = Math.floor((durationMs % 60000) / 1000);
      const formattedDuration =
        durationMinutes > 0
          ? `${durationMinutes}m ${durationSeconds}s`
          : `${durationSeconds}s`;

      resolvedTrackers.push({
        tracker: updated,
        policyName: tracker.policy.name,
        isBreached,
        durationMs,
        formattedDuration,
      });

      // 6. Dispatch Audit Sink Event
      if (this.auditSink) {
        await this.auditSink.onTrackerResolved({
          trackerId: tracker.id,
          policyId: tracker.policyId,
          policyName: tracker.policy.name,
          entityId: tracker.entityId,
          entityType: tracker.entityType,
          status: finalStatus,
          startedAt: tracker.startedAt,
          targetAt: tracker.targetAt,
          stoppedAt: now,
          durationMs,
          durationMinutes,
          durationSeconds,
          formattedDuration,
          metadata: params.metadata,
        });
      }
    }

    return {
      evaluatedTrackersCount: activeTrackers.length,
      resolvedTrackers,
    };
  }

  /**
   * Computes the real-time status, remaining time and budget consumption percentage of an active tracker.
   */
  public calculateRemainingTime(tracker: ISlaTracker): {
    isBreached: boolean;
    remainingMs: number;
    remainingSeconds: number;
    percentageConsumed: number;
  } {
    const now = this.nowProvider();
    const totalDurationMs = tracker.targetAt.getTime() - tracker.startedAt.getTime();
    const elapsedMs = now.getTime() - tracker.startedAt.getTime();
    const remainingMs = tracker.targetAt.getTime() - now.getTime();

    const percentageConsumed =
      totalDurationMs > 0
        ? Math.min(100, Math.max(0, (elapsedMs / totalDurationMs) * 100))
        : 100;

    return {
      isBreached: remainingMs < 0,
      remainingMs,
      remainingSeconds: Math.floor(remainingMs / 1000),
      percentageConsumed: Number(percentageConsumed.toFixed(2)),
    };
  }

  /**
   * Helper to create an SLA Policy
   */
  public async createPolicy(
    policy: Omit<ISlaPolicy, 'id' | 'createdAt' | 'updatedAt'>,
    tx?: unknown
  ): Promise<ISlaPolicy> {
    return this.storageDriver.createPolicy(policy, tx);
  }

  /**
   * Helper to retrieve policies
   */
  public async getPolicies(
    filter?: { isActive?: boolean; entityType?: string },
    tx?: unknown
  ): Promise<ISlaPolicy[]> {
    return this.storageDriver.findPolicies(filter, tx);
  }
}
