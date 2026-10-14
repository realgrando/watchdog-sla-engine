import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConditionEvaluator,
  ConsoleAuditSink,
  InMemorySlaStorage,
  ISlaAuditSink,
  ISlaTracker,
  WatchdogSlaEngine,
} from '../src';

describe('WatchdogSlaEngine (Unit & Integration Tests)', () => {
  let storage: InMemorySlaStorage;
  let engine: WatchdogSlaEngine;
  let virtualTime: Date;
  let mockAuditSink: ISlaAuditSink;

  beforeEach(async () => {
    storage = new InMemorySlaStorage();
    virtualTime = new Date('2026-10-14T12:00:00.000Z');

    mockAuditSink = {
      onTrackerStarted: vi.fn(),
      onTrackerResolved: vi.fn(),
    };

    engine = new WatchdogSlaEngine({
      storageDriver: storage,
      auditSink: mockAuditSink,
      nowProvider: () => new Date(virtualTime),
    });

    // Seed test policies
    await engine.createPolicy({
      name: 'Standard Ticket Resolution',
      entityType: 'ticket',
      triggerEvent: 'TICKET_CREATED',
      stopEvent: 'TICKET_RESOLVED',
      targetMinutes: 60,
      isActive: true,
    });

    await engine.createPolicy({
      name: 'P1 Incident Escalation',
      entityType: 'incident',
      triggerEvent: 'INCIDENT_DECLARED',
      stopEvent: 'INCIDENT_ACKNOWLEDGED',
      targetMinutes: 15,
      isActive: true,
    });
  });

  it('should start tracker when trigger matches an active policy', async () => {
    const result = await engine.evaluateTriggers({
      entityId: 'ticket-100',
      entityType: 'ticket',
      triggerEvent: 'TICKET_CREATED',
    });

    expect(result.startedTrackers).toHaveLength(1);
    const tracker = result.startedTrackers[0];
    expect(tracker.entityId).toBe('ticket-100');
    expect(tracker.status).toBe('ACTIVE');
    expect(tracker.targetAt.getTime()).toBe(
      virtualTime.getTime() + 60 * 60 * 1000
    );

    expect(mockAuditSink.onTrackerStarted).toHaveBeenCalledTimes(1);
  });

  it('should guarantee idempotency by skipping duplicate concurrent triggers', async () => {
    // First trigger starts tracker
    const res1 = await engine.evaluateTriggers({
      entityId: 'ticket-101',
      entityType: 'ticket',
      triggerEvent: 'TICKET_CREATED',
    });
    expect(res1.startedTrackers).toHaveLength(1);

    // Second trigger with identical entity and event must be ignored
    const res2 = await engine.evaluateTriggers({
      entityId: 'ticket-101',
      entityType: 'ticket',
      triggerEvent: 'TICKET_CREATED',
    });
    expect(res2.startedTrackers).toHaveLength(0);
    expect(res2.skippedDueToDuplicationCount).toBe(1);

    // Audit sink should have been called only once
    expect(mockAuditSink.onTrackerStarted).toHaveBeenCalledTimes(1);
  });

  it('should mark SLA as MET when resolved within budget', async () => {
    await engine.evaluateTriggers({
      entityId: 'ticket-102',
      entityType: 'ticket',
      triggerEvent: 'TICKET_CREATED',
    });

    // Advance 45 minutes (within 60m budget)
    virtualTime = new Date(virtualTime.getTime() + 45 * 60 * 1000);

    const stopResult = await engine.evaluateStops({
      entityId: 'ticket-102',
      entityType: 'ticket',
      stopEvent: 'TICKET_RESOLVED',
    });

    expect(stopResult.resolvedTrackers).toHaveLength(1);
    const resolved = stopResult.resolvedTrackers[0];
    expect(resolved.tracker.status).toBe('MET');
    expect(resolved.isBreached).toBe(false);
    expect(resolved.formattedDuration).toBe('45m 0s');

    expect(mockAuditSink.onTrackerResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'MET',
        entityId: 'ticket-102',
      })
    );
  });

  it('should mark SLA as BREACHED when resolved after deadline', async () => {
    await engine.evaluateTriggers({
      entityId: 'incident-500',
      entityType: 'incident',
      triggerEvent: 'INCIDENT_DECLARED',
    });

    // Advance 25 minutes (budget was 15 minutes)
    virtualTime = new Date(virtualTime.getTime() + 25 * 60 * 1000);

    const stopResult = await engine.evaluateStops({
      entityId: 'incident-500',
      entityType: 'incident',
      stopEvent: 'INCIDENT_ACKNOWLEDGED',
    });

    expect(stopResult.resolvedTrackers).toHaveLength(1);
    const resolved = stopResult.resolvedTrackers[0];
    expect(resolved.tracker.status).toBe('BREACHED');
    expect(resolved.isBreached).toBe(true);
    expect(resolved.formattedDuration).toBe('25m 0s');

    expect(mockAuditSink.onTrackerResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'BREACHED',
        entityId: 'incident-500',
      })
    );
  });

  it('should correctly evaluate dynamic conditionPayload matching', async () => {
    await engine.createPolicy({
      name: 'VIP Urgent Only',
      entityType: 'ticket',
      triggerEvent: 'VIP_TICKET_CREATED',
      stopEvent: 'VIP_TICKET_RESOLVED',
      targetMinutes: 10,
      conditionPayload: { priority: 'URGENT', tier: 'ENTERPRISE' },
      isActive: true,
    });

    // 1. Mismatched metadata -> ignored
    const resIgnored = await engine.evaluateTriggers({
      entityId: 'ticket-non-urgent',
      entityType: 'ticket',
      triggerEvent: 'VIP_TICKET_CREATED',
      metadata: { priority: 'LOW', tier: 'ENTERPRISE' },
    });
    expect(resIgnored.startedTrackers).toHaveLength(0);

    // 2. Matching metadata -> accepted
    const resAccepted = await engine.evaluateTriggers({
      entityId: 'ticket-urgent',
      entityType: 'ticket',
      triggerEvent: 'VIP_TICKET_CREATED',
      metadata: { priority: 'URGENT', tier: 'ENTERPRISE' },
    });
    expect(resAccepted.startedTrackers).toHaveLength(1);
  });

  it('should correctly calculate real-time remaining time and budget consumption', () => {
    const startedAt = new Date('2026-10-14T12:00:00.000Z');
    const targetAt = new Date('2026-10-14T13:00:00.000Z'); // 60 minutes

    const tracker: ISlaTracker = {
      id: 'trk-1',
      policyId: 'pol-1',
      entityId: 'ent-1',
      status: 'ACTIVE',
      startedAt,
      targetAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    // At 30 minutes in -> 50% consumed
    virtualTime = new Date('2026-10-14T12:30:00.000Z');
    const tel1 = engine.calculateRemainingTime(tracker);
    expect(tel1.isBreached).toBe(false);
    expect(tel1.percentageConsumed).toBe(50);
    expect(tel1.remainingSeconds).toBe(1800);

    // At 75 minutes in -> Breached, remaining < 0
    virtualTime = new Date('2026-10-14T13:15:00.000Z');
    const tel2 = engine.calculateRemainingTime(tracker);
    expect(tel2.isBreached).toBe(true);
    expect(tel2.remainingSeconds).toBe(-900);
  });
});
