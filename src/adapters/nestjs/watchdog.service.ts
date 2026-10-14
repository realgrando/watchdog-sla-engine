/**
 * NestJS Injectable Wrapper for WatchdogSlaEngine
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WatchdogSlaEngine } from '../../core/engine';
import {
  ISlaAuditSink,
  ISlaPolicy,
  ISlaStorageDriver,
  ISlaTracker,
  StopEvaluationParams,
  StopEvaluationResult,
  TriggerEvaluationParams,
  TriggerEvaluationResult,
} from '../../interfaces';
import {
  WATCHDOG_AUDIT_TOKEN,
  WATCHDOG_STORAGE_TOKEN,
} from './tokens';

@Injectable()
export class WatchdogSlaService {
  private readonly logger = new Logger(WatchdogSlaService.name);
  private readonly engine: WatchdogSlaEngine;

  constructor(
    @Inject(WATCHDOG_STORAGE_TOKEN)
    private readonly storageDriver: ISlaStorageDriver,
    @Optional()
    @Inject(WATCHDOG_AUDIT_TOKEN)
    private readonly auditSink?: ISlaAuditSink
  ) {
    this.engine = new WatchdogSlaEngine({
      storageDriver: this.storageDriver,
      auditSink: this.auditSink,
    });
  }

  public getRawEngine(): WatchdogSlaEngine {
    return this.engine;
  }

  public async evaluateTriggers(
    params: TriggerEvaluationParams,
    tx?: unknown
  ): Promise<TriggerEvaluationResult> {
    const result = await this.engine.evaluateTriggers(params, tx);
    for (const tracker of result.startedTrackers) {
      this.logger.log(
        `[SLA Started] Tracker <${tracker.id}> initiated for Entity <${params.entityId}>`
      );
    }
    return result;
  }

  public async evaluateStops(
    params: StopEvaluationParams,
    tx?: unknown
  ): Promise<StopEvaluationResult> {
    const result = await this.engine.evaluateStops(params, tx);
    for (const item of result.resolvedTrackers) {
      const icon = item.isBreached ? '❌ BREACHED' : '✅ MET';
      this.logger.log(
        `[SLA Resolved] Tracker <${item.tracker.id}> ${icon} for Entity <${params.entityId}> in ${item.formattedDuration}`
      );
    }
    return result;
  }

  public calculateRemainingTime(tracker: ISlaTracker) {
    return this.engine.calculateRemainingTime(tracker);
  }

  public async createPolicy(
    policy: Omit<ISlaPolicy, 'id' | 'createdAt' | 'updatedAt'>,
    tx?: unknown
  ): Promise<ISlaPolicy> {
    return this.engine.createPolicy(policy, tx);
  }

  public async getPolicies(
    filter?: { isActive?: boolean; entityType?: string },
    tx?: unknown
  ): Promise<ISlaPolicy[]> {
    return this.engine.getPolicies(filter, tx);
  }
}
