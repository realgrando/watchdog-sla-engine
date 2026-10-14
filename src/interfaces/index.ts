/**
 * Watchdog SLA Engine - Domain Interfaces and Port Contracts
 * Hexagonal Architecture / Ports & Adapters
 */

export type SlaStatus = 'ACTIVE' | 'MET' | 'BREACHED' | 'CANCELLED';

export type SlaTriggerEvent =
  | 'ENTITY_CREATED'
  | 'STAGE_ENTERED'
  | 'STATE_TRANSITIONED'
  | 'TASK_CREATED'
  | 'AGENT_DISPATCHED'
  | (string & {});

export type SlaStopEvent =
  | 'STAGE_CHANGED'
  | 'ACTIVITY_LOGGED'
  | 'TASK_COMPLETED'
  | 'STATUS_WON'
  | 'AGENT_COMPLETED'
  | (string & {});

/**
 * Definition of an SLA Policy (The Rule Specification)
 */
export interface ISlaPolicy {
  id: string;
  name: string;
  description?: string | null;
  entityType?: string | null;
  scopeId?: string | null;
  targetScopeId?: string | null;
  triggerEvent: SlaTriggerEvent;
  stopEvent: SlaStopEvent;
  targetMinutes: number;
  conditionPayload?: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

/**
 * An active or resolved SLA Tracker (The Timer / Watchdog Instance)
 */
export interface ISlaTracker {
  id: string;
  policyId: string;
  entityId: string;
  entityType?: string | null;
  status: SlaStatus;
  startedAt: Date;
  targetAt: Date;
  stoppedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Compound tracker with joined policy definition for fast evaluation
 */
export interface ISlaTrackerWithPolicy extends ISlaTracker {
  policy: Pick<
    ISlaPolicy,
    | 'id'
    | 'name'
    | 'triggerEvent'
    | 'stopEvent'
    | 'targetScopeId'
    | 'conditionPayload'
    | 'targetMinutes'
  >;
}

/**
 * Trigger Evaluation Parameters
 */
export interface TriggerEvaluationParams {
  entityId: string;
  entityType?: string;
  triggerEvent: SlaTriggerEvent;
  scopeId?: string;
  metadata?: Record<string, unknown>;
  overrideTargetMinutes?: number;
}

/**
 * Stop Evaluation Parameters
 */
export interface StopEvaluationParams {
  entityId: string;
  entityType?: string;
  stopEvent: SlaStopEvent;
  scopeId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Audit Event emitted when an SLA Tracker is activated
 */
export interface SlaTrackerStartedEvent {
  trackerId: string;
  policyId: string;
  policyName: string;
  entityId: string;
  entityType?: string | null;
  targetMinutes: number;
  targetAt: Date;
  startedAt: Date;
  metadata?: Record<string, unknown> | null;
}

/**
 * Audit Event emitted when an SLA Tracker reaches completion
 */
export interface SlaTrackerResolvedEvent {
  trackerId: string;
  policyId: string;
  policyName: string;
  entityId: string;
  entityType?: string | null;
  status: 'MET' | 'BREACHED' | 'CANCELLED';
  startedAt: Date;
  targetAt: Date;
  stoppedAt: Date;
  durationMs: number;
  durationMinutes: number;
  durationSeconds: number;
  formattedDuration: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Output Summary returned after trigger evaluations
 */
export interface TriggerEvaluationResult {
  evaluatedPoliciesCount: number;
  startedTrackers: ISlaTracker[];
  skippedDueToDuplicationCount: number;
}

/**
 * Output Summary returned after stop evaluations
 */
export interface StopEvaluationResult {
  evaluatedTrackersCount: number;
  resolvedTrackers: Array<{
    tracker: ISlaTracker;
    policyName: string;
    isBreached: boolean;
    durationMs: number;
    formattedDuration: string;
  }>;
}

/**
 * Storage Port: Contract required for persistence drivers (InMemory, Drizzle, Prisma, etc.)
 */
export interface ISlaStorageDriver {
  findActivePoliciesByTrigger(
    triggerEvent: SlaTriggerEvent,
    entityType?: string,
    scopeId?: string,
    tx?: unknown
  ): Promise<ISlaPolicy[]>;

  findActiveTrackersByEntity(
    entityId: string,
    entityType?: string,
    tx?: unknown
  ): Promise<ISlaTrackerWithPolicy[]>;

  findExistingActiveTracker(
    policyId: string,
    entityId: string,
    tx?: unknown
  ): Promise<ISlaTracker | null>;

  createTracker(
    tracker: Omit<ISlaTracker, 'id' | 'createdAt' | 'updatedAt'>,
    tx?: unknown
  ): Promise<ISlaTracker>;

  updateTrackerStatus(
    trackerId: string,
    status: SlaStatus,
    stoppedAt: Date,
    metadata?: Record<string, unknown>,
    tx?: unknown
  ): Promise<ISlaTracker>;

  findPolicies(
    filter?: { isActive?: boolean; entityType?: string },
    tx?: unknown
  ): Promise<ISlaPolicy[]>;

  createPolicy(
    policy: Omit<ISlaPolicy, 'id' | 'createdAt' | 'updatedAt'>,
    tx?: unknown
  ): Promise<ISlaPolicy>;

  updatePolicy(
    id: string,
    policy: Partial<ISlaPolicy>,
    tx?: unknown
  ): Promise<ISlaPolicy>;
}

/**
 * Audit Sink Port: Contract for logging, telemetry, or notifications
 */
export interface ISlaAuditSink {
  onTrackerStarted(event: SlaTrackerStartedEvent): Promise<void> | void;
  onTrackerResolved(event: SlaTrackerResolvedEvent): Promise<void> | void;
}

/**
 * Global Engine Configuration
 */
export interface ISlaEngineOptions {
  storageDriver: ISlaStorageDriver;
  auditSink?: ISlaAuditSink;
  clockDriftToleranceMs?: number;
  nowProvider?: () => Date;
}
