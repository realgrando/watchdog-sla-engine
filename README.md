# watchdog-sla-engine

Reference implementation of a deterministic, event-driven SLA policy engine and lifecycle state machine in TypeScript. Built around the **Clock vs. Alarm** architectural paradigm to replace periodic `O(N)` database polling with atomic, `O(1)` state evaluations inside ACID transactions.

> **Architectural Context & Origin**
> 
> I originally engineered this module inside **`nivix-os`** (the proprietary operations and CRM monolith at [Nivix Company](https://github.com/nivix-company)). In our production workflow, tracking response and resolution SLAs across thousands of concurrent pipeline entities and automated tasks via traditional cron jobs created the classic polling bottleneck—unnecessary I/O spikes and race conditions during stage transitions.
> 
> I extracted, sanitized, and decoupled this core engine from our business domain using **Hexagonal Architecture (Ports & Adapters)** to serve as a standalone architectural study and reference implementation for lockless temporal state machines.

---

## The Architectural Problem: Why Naive SLAs Fail at Scale

Most applications implement Service Level Agreements (SLAs) using periodic cron workers that scan the database:

```sql
-- The Naive Anti-Pattern: Scans the entire table every 60 seconds
SELECT id, created_at, status 
FROM tasks 
WHERE status = 'PENDING' AND now() - created_at > INTERVAL '15 minutes';
```

As entity volumes grow past 100k+ records, this approach breaks down under load:

1. **Database Lock Contention & I/O Spikes:** Periodic `O(N)` table scans thrash PostgreSQL buffer caches and compete for row/page locks against live transactions.
2. **Clock Jitter & Quantization Drift:** If a cron fires every minute, a 5-minute SLA will trigger anywhere between 5m 01s and 5m 59s. Micro-delays accumulate and distort historical metrics.
3. **State Machine Race Conditions:** If an entity is updated while the cron worker evaluates its state, concurrent writes collide—generating false "SLA Breached" alerts for tasks that were already completed.

### The Solution: Event-Driven O(1) Alarm Engine

`watchdog-sla-engine` decouples **duration tracking** from **threshold enforcement**:

- **The Clock (Passive):** Historical duration is derived from immutable, append-only event streams.
- **The Alarm (Active):** A temporal state machine evaluates deadlines at transition time inside the entity's native ACID transaction.

When a trigger fires (`evaluateTriggers`), the target deadline (`targetAt = now + targetMinutes`) is persisted immediately. When a terminal event occurs (`evaluateStops`), the engine executes an `O(1)` timestamp comparison. No background table sweeping is required.

---

## Core Architecture & Design Patterns

The engine is structured around **Hexagonal Architecture (Ports and Adapters)**:

- **Core Domain:** Zero external dependencies (`0 KB` in `node_modules`). Pure TypeScript state machine and condition evaluator.
- **Storage Port (`ISlaStorageDriver`):** Swappable persistence drivers (In-Memory for tests/serverless, Drizzle ORM for PostgreSQL transactions).
- **Audit Port (`ISlaAuditSink`):** Telemetry stream decoupled from storage (STDOUT, EventEmitter, or message brokers).

```text
                            ┌───────────────────────────────────┐
                            │         Domain Mutation           │
                            │   (HTTP Controller / Queue Job)   │
                            └─────────────────┬─────────────────┘
                                              │
                                              ▼
                            ┌───────────────────────────────────┐
                            │        WatchdogSlaEngine          │
                            │    (Deterministic Core Engine)    │
                            └─────────────────┬─────────────────┘
                                              │
                     ┌────────────────────────┴────────────────────────┐
                     ▼                                                 ▼
      ┌──────────────────────────────┐                  ┌──────────────────────────────┐
      │    ISlaStorageDriver Port    │                  │      ISlaAuditSink Port      │
      └──────────────┬───────────────┘                  └──────────────┬───────────────┘
                     │                                                 │
          ┌──────────┴──────────┐                           ┌──────────┴──────────┐
          ▼                     ▼                           ▼                     ▼
┌──────────────────┐  ┌──────────────────┐        ┌──────────────────┐  ┌──────────────────┐
│ InMemoryStorage  │  │ DrizzlePgStorage │        │ ConsoleAuditSink │  │ EventEmitterSink │
│  (Zero Runtime)  │  │ (ACID Postgres)  │        │   (Clean Logs)   │  │ (NestJS EventBus)│
└──────────────────┘  └──────────────────┘        └──────────────────┘  └──────────────────┘
```

### Design Patterns Applied

- **Clock vs. Alarm:** Segregates passive measurement from active alerting.
- **Strategy Pattern:** Dynamic evaluation of arbitrary JSONB rules via `ConditionEvaluator`.
- **In-Flight Mutex Barrier:** Suppresses concurrent duplicate triggers across microtasks and distributed workers.
- **Ports & Adapters:** Isolates business rules from infrastructure, allowing full testability without a live database.

---

## Engineering Rationale (Why This Stack)

- **Pure TypeScript Core:** Zero runtime dependencies. Runs natively on Node.js, Bun, Deno, or edge runtimes.
- **PostgreSQL JSONB (`condition_payload`):** Avoids Entity-Attribute-Value (EAV) join bottlenecks while supporting custom, schema-free rule predicates (e.g., `{ "priority": "URGENT", "requireAllTasks": true }`).
- **Drizzle ORM Adapter:** Provides strict SQL type inference with zero runtime overhead, operating directly inside caller transactions (`tx`).
- **NestJS Integration:** Exposed as an optional dynamic module (`WatchdogSlaModule.forRoot()`) for modular backend architectures.

---

## Production Use Cases

### 1. Operational Workflows & Incident Escalations
Enforces deterministic response and resolution guarantees across pipeline stages, support tickets, and P1 infrastructure incidents.

### 2. Autonomous AI Agents & Tool-Calling Guardrails
LLM agents frequently get stuck in recursive tool-calling loops or hang on slow external APIs. Because `watchdog-sla-engine` is deterministic, it acts as a hard temporal circuit-breaker outside the model's context:

```typescript
// Enforce a strict 3-minute hard ceiling on an AI sub-agent task
await engine.evaluateTriggers({
  entityId: agentTaskId,
  entityType: 'ai_subagent',
  triggerEvent: 'AGENT_DISPATCHED',
  overrideTargetMinutes: 3,
  metadata: { model: 'claude-3-7-sonnet', tool: 'postgres_search' }
});

// Inside the agent execution loop:
const telemetry = engine.calculateRemainingTime(activeTracker);
if (telemetry.isBreached) {
  throw new Error('SLA Circuit Breaker: Halting runaway autonomous agent loop.');
}
```

---

## Architectural Usage

### 1. Standalone Core (In-Memory)
With the domain core isolated from the database layer, state transitions and rule evaluations can be instantiated and verified directly in memory:

```typescript
import { 
  WatchdogSlaEngine, 
  InMemorySlaStorage, 
  ConsoleAuditSink 
} from './src';

const storage = new InMemorySlaStorage();
const auditSink = new ConsoleAuditSink();
const engine = new WatchdogSlaEngine({ storageDriver: storage, auditSink });

// 1. Define the SLA contract (15-minute ceiling)
await engine.createPolicy({
  name: 'P1 Incident Triage',
  entityType: 'incident',
  triggerEvent: 'INCIDENT_DECLARED',
  stopEvent: 'INCIDENT_ACKNOWLEDGED',
  targetMinutes: 15,
  isActive: true,
});

// 2. Trigger when the domain event occurs
await engine.evaluateTriggers({
  entityId: 'inc-9021',
  entityType: 'incident',
  triggerEvent: 'INCIDENT_DECLARED',
});

// 3. Evaluate O(1) deadline against transition timestamp
const result = await engine.evaluateStops({
  entityId: 'inc-9021',
  entityType: 'incident',
  stopEvent: 'INCIDENT_ACKNOWLEDGED',
});

console.log(result.resolvedTrackers[0].tracker.status); // 'MET' | 'BREACHED'
console.log(result.resolvedTrackers[0].formattedDuration); // '12m 45s'
```

### 2. Production Adapter (NestJS + Drizzle PostgreSQL)
In production (`nivix-os`), the engine is registered via a dynamic NestJS module backed by the PostgreSQL Drizzle adapter (`src/adapters/drizzle`), allowing SLA evaluations to share the caller's ACID transaction (`tx`):

```typescript
import { Module } from '@nestjs/common';
import { WatchdogSlaModule, DrizzleSlaStorage } from './src/adapters/nestjs';
import { db } from './database';

@Module({
  imports: [
    WatchdogSlaModule.forRoot({
      storageDriver: new DrizzleSlaStorage(db),
    }),
  ],
})
export class AppModule {}
```

---

## Running the Simulation & Tests Locally

This repository includes a self-contained simulation and test suite that runs in-memory without requiring a PostgreSQL instance:

```bash
git clone [https://github.com/realgrando/watchdog-sla-engine.git](https://github.com/realgrando/watchdog-sla-engine.git)
cd watchdog-sla-engine
npm install

# Run the real-time 4-scenario simulation (Happy Path, Breach, AI Guardrail, Mutex Barrier)
npm run simulate

# Run the Vitest unit and concurrency test suite
npm test
```

## Deep Dive Engineering Notes

For a granular breakdown of the concurrency trade-offs, lockless state calculation, and design decisions behind this extraction, see **[docs/ARCHITECTURE_DEEP_DIVE.md](./docs/ARCHITECTURE_DEEP_DIVE.md)**.

## License

MIT © [Gustavo Grando](https://github.com/realgrando)
