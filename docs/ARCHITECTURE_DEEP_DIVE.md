# Architecture Deep Dive: Watchdog SLA Engine
**Author:** Gustavo Grando (`@realgrando`)  
**Design Paradigm:** Hexagonal Architecture / Ports & Adapters  
**Domain Pattern:** Clock vs. Alarm Duality & Event-Driven State Machines  

---

## 1. The Core Duality: Passive Clock vs. Active Alarm

When architects design SLA (Service Level Agreement) systems, they frequently conflate two fundamentally different responsibilities:
1. **Passive Time Tracking ("The Clock"):** Measuring how long an entity spent in a specific state or lifecycle stage.
2. **Autonomous Deadline Enforcement ("The Alarm"):** Triggering deterministic business interventions, escalations, or state mutations when a pre-negotiated temporal threshold is breached.

### The Naive Anti-Pattern: Cron Polling at Scale ($O(N)$)
The typical naive implementation runs a scheduled cron job every minute:
```sql
-- The Anti-Pattern: Scans the entire table every 60 seconds
SELECT id, created_at, status 
FROM tickets 
WHERE status = 'OPEN' AND now() - created_at > INTERVAL '15 minutes';
```
This pattern catastrophically degrades under production workloads:
- **I/O Contention & Table Locks:** As the dataset scales to $10^5$ - $10^7$ rows, sequential index scans lock pages and thrash PostgreSQL buffer pools.
- **Temporal Quantization Error (Clock Jitter):** If the cron runs at minute intervals, an SLA targeted for 5 minutes might only be evaluated at 5m 59s.
- **Race Conditions with Concurrent Transitions:** If an entity is transitioning stages while the cron job sweeps, optimistic concurrency control fails, causing ghost breaches on already-resolved entities.

### The Watchdog Solution: Event-Driven O(1) Alarm Engine
`watchdog-sla-engine` decouples the clock from the alarm completely:
- The **Clock** is maintained as an append-only event stream (the immutable entity audit log).
- The **Alarm** is modeled as a state machine evaluated synchronously **inside the entity's mutation transaction** or asynchronously via domain event listeners.

```
       [Domain Mutation Event] 
                 │
                 ▼
  ┌───────────────────────────────┐
  │   watchdog-sla-engine         │
  │   (Inside ACID Transaction)   │
  └──────────────┬────────────────┘
                 │
      ┌──────────┴──────────┐
      ▼                     ▼
[evaluateTriggers]    [evaluateStops]
  - Idempotency check   - Target scope match
  - JSONB condition     - Time delta comparison
  - Compute targetAt    - Classify MET / BREACHED
      │                     │
      ▼                     ▼
[sla_trackers: ACTIVE] [sla_trackers: MET / BREACHED]
```

When an entity is created or transitioned, `evaluateTriggers()` computes `targetAt = now() + targetMinutes * 60000` once. When a terminal or intermediate event occurs, `evaluateStops()` compares the timestamp against `targetAt` in $O(1)$ time. Zero background sweeping required.

---

## 2. Line-by-Line Anatomy of the Critical Algorithm

### A. Trigger Evaluation & Idempotency Barrier

```typescript
// From src/core/engine.ts
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
```

#### Why we filter by `triggerEvent` and `scopeId` at the storage layer:
Instead of loading all policies into Node.js memory, the query pushes predicate evaluation to the indexed PostgreSQL level:
```sql
SELECT * FROM sla_policies 
WHERE is_active = true 
  AND deleted_at IS NULL 
  AND trigger_event = $1 
  AND (scope_id IS NULL OR scope_id = $2);
```
This guarantees that policy resolution executes in sub-millisecond latency regardless of policy count.

```typescript
// 3. Idempotency Check: Prevent duplicate concurrent active trackers
const existing = await this.storageDriver.findExistingActiveTracker(
  policy.id,
  params.entityId,
  tx
);

if (existing) {
  skippedDueToDuplication++;
  continue;
}
```

#### The Concurrency Trap It Solves:
In distributed systems, message brokers (Kafka, SQS, RabbitMQ) and webhooks guarantee **at-least-once delivery**. A rapid retry or parallel worker could process the same trigger twice within a few milliseconds.
Without the idempotency check, multiple trackers would be created for the same policy and entity, resulting in:
- Conflicting breach alerts.
- Skewed compliance metrics in analytics pipelines.
- Double-escalation to on-call engineers.

The engine verifies active tracker existence within the current transaction context `tx`. When backed by the composite index on `(entity_id, status)` or a PostgreSQL partial unique index:
```sql
CREATE UNIQUE INDEX idx_unique_active_tracker 
ON sla_trackers (policy_id, entity_id) 
WHERE status = 'ACTIVE';
```
Any concurrent attempt is cleanly rejected without database lock escalations.

---

### B. Stop Evaluation & Deterministic Breach Detection

```typescript
// Deterministic Breach Evaluation
const isBreached =
  now.getTime() > tracker.targetAt.getTime() + this.clockDriftToleranceMs;
const finalStatus: SlaStatus = isBreached ? 'BREACHED' : 'MET';
```

#### Why `targetAt` Comparison is Pure and Deterministic:
Notice that `isBreached` is evaluated against `tracker.targetAt` which was locked at tracker creation time.
- If a server clock drifts by a few milliseconds, `clockDriftToleranceMs` absorbs the jitter.
- The evaluation does not depend on dynamic duration recalculations or external APIs.
- The duration telemetry is computed at stop time:
```typescript
const durationMs = Math.max(0, now.getTime() - tracker.startedAt.getTime());
```
This guarantees that even if logs or audit sinks fail, the persisted record in `sla_trackers` remains mathematically consistent.

---

## 3. Dynamic Condition Matching: JSONB Without EAV Bloat

Traditional relational models use Entity-Attribute-Value (EAV) tables for dynamic rule evaluation:
```sql
-- The EAV nightmare: Multiple joins for a single rule check
SELECT * FROM policy_conditions pc
JOIN attribute_values av ON pc.attr_id = av.attr_id
WHERE av.value = 'URGENT';
```
In `watchdog-sla-engine`, we leverage PostgreSQL's native binary JSON format (`jsonb`) handled through `ConditionEvaluator`:

```typescript
// From src/core/evaluator.ts
export class ConditionEvaluator {
  public static matches(
    conditionPayload?: Record<string, unknown> | null,
    metadata?: Record<string, unknown> | null
  ): boolean {
    if (!conditionPayload || Object.keys(conditionPayload).length === 0) {
      return true;
    }
    if (!metadata) return false;

    for (const [key, expectedValue] of Object.entries(conditionPayload)) {
      const actualValue = metadata[key];
      // Array membership, exact primitive matching, or deep structural equality
    }
    return true;
  }
}
```

### Why this is superior:
1. **Zero Join Overhead:** The policy row holds its criteria directly in `condition_payload`.
2. **Schema Flexibility:** Adding rules like `{ "tier": "ENTERPRISE", "requireAllTasks": true }` requires zero database migrations.
3. **Runtime Safety:** The evaluation is safe against undefined attributes and performs no `eval()` or dynamic code injection.

---

## 4. Deterministic Guardrail for Autonomous AI Agents

In contemporary autonomous agent architectures (AutoGPT, LangChain, CrewAI), LLM agents execute multi-step tool-calling loops:
```
[User Request] ──> [LLM Thought] ──> [Tool Call 1] ──> [Tool Call 2] ... ──> [Response]
```

### The Autonomous Agent Failure Modes:
1. **Hallucinatory Infinite Loops:** The agent gets stuck repeatedly calling tools with slightly mutated arguments.
2. **Token & Latency Exhaustion:** A sub-agent hangs waiting on third-party HTTP responses.
3. **Non-Deterministic Costs:** Unbounded execution duration directly drains API credit balances.

### How `watchdog-sla-engine` Solves This:
The engine provides a **Deterministic Temporal Circuit-Breaker**:

```typescript
// 1. Agent starts tool execution
await engine.evaluateTriggers({
  entityId: agentTaskId,
  entityType: 'ai_subagent',
  triggerEvent: 'AGENT_DISPATCHED',
  overrideTargetMinutes: 3, // Hard cap: 3 minutes maximum
  metadata: { model: 'claude-3-7-sonnet', tool: 'postgres_search' }
});

// 2. Before every tool invocation, the runtime checks the watchdog:
const telemetry = engine.calculateRemainingTime(activeTracker);
if (telemetry.isBreached) {
  throw new AgentTimeoutCircuitBreakerException('SLA Breached: Aborting runaway agent loop');
}

// 3. When agent completes, halt the watchdog:
await engine.evaluateStops({
  entityId: agentTaskId,
  entityType: 'ai_subagent',
  stopEvent: 'AGENT_COMPLETED'
});
```

The AI agent runtime no longer relies on fragile internal counters. The watchdog acts as an external, unforgeable arbiter of execution boundaries.

---

## 5. Architectural Ports & Adapters Breakdown

```
                    ┌────────────────────────────┐
                    │     Application Layer      │
                    │   (NestJS / Fastify / CLI) │
                    └─────────────┬──────────────┘
                                  │
                                  ▼
                    ┌────────────────────────────┐
                    │     WatchdogSlaEngine      │
                    │     (Pure TypeScript Core) │
                    └─────────────┬──────────────┘
                                  │
         ┌────────────────────────┴────────────────────────┐
         ▼                                                 ▼
┌───────────────────────────────┐         ┌───────────────────────────────┐
│     ISlaStorageDriver Port    │         │       ISlaAuditSink Port      │
└──────────────┬────────────────┘         └───────────────┬───────────────┘
               │                                          │
       ┌───────┴────────┐                         ┌───────┴────────┐
       ▼                ▼                         ▼                ▼
[InMemoryStorage] [DrizzlePgStorage]       [ConsoleSink]  [EventEmitterSink]
 (Zero Deps)      (PostgreSQL ACID)         (STDOUT Logs)  (NestJS EventBus)
```

By decoupling through interfaces:
- **Zero Framework Lock-in:** The core has zero external dependencies.
- **Instant Testability:** The in-memory driver runs unit test suites in under 50ms without dockerized databases.
- **Production Grade:** The Drizzle adapter provides ACID transaction safety in enterprise backends.
