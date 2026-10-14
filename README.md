# watchdog-sla-engine

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript: Strict](https://img.shields.io/badge/TypeScript-Strict%205.7-blue.svg)](https://www.typescriptlang.org/)
[![Architecture: Hexagonal](https://img.shields.io/badge/Architecture-Ports%20%26%20Adapters-emerald.svg)](https://en.wikipedia.org/wiki/Hexagonal_architecture_(software))
[![Tests: Vitest](https://img.shields.io/badge/Tests-Vitest%20Passed-brightgreen.svg)](https://vitest.dev/)

**Deterministic, event-driven SLA policy engine and lifecycle state machine for TypeScript and Node.js.** Engineered around the **Clock vs. Alarm** architectural paradigm, `watchdog-sla-engine` eliminates traditional periodic polling anti-patterns ($O(N)$ database cron sweeps) in favor of atomic, $O(1)$ state evaluations inside transactional workflows. Designed as a foundational guardrail for distributed task orchestration, high-concurrency ticket/incident management, and autonomous AI agent tool-calling loops.

---

## The Architectural Problem: Why Naive SLAs Fail at Scale

Most engineering teams implement Service Level Agreements (SLAs) using periodic cron workers:
```sql
-- The Naive Anti-Pattern: Scans the entire table every 60 seconds
SELECT id, created_at, status 
FROM tasks 
WHERE status = 'PENDING' AND now() - created_at > INTERVAL '15 minutes';
```

As entity volumes grow past $10^5$ records, this approach inevitably collapses:
1. **Database Lock Contention & I/O Spikes:** Periodic $O(N)$ table scans thrash PostgreSQL buffer caches and compete for row/page locks against live customer transactions.
2. **Clock Jitter & Quantization Drift:** If a cron fires every minute, a 5-minute SLA will trigger anywhere between 5m 01s and 5m 59s. Micro-delays accumulate, distorting historical reporting.
3. **State Machine Race Conditions:** If an entity is updated while the cron job evaluates its state, workers experience race conditions, generating false "SLA Breached" alerts for tasks that were already completed.

### The Solution: Event-Driven O(1) Alarm Engine
`watchdog-sla-engine` decouples **duration tracking** from **threshold enforcement**:
- **The Clock (Passive):** Historical duration is derived from immutable, append-only event streams.
- **The Alarm (Active):** A temporal state machine evaluates deadlines at transition time inside the entity's native ACID transaction.

When a trigger fires (`evaluateTriggers`), the target deadline (`targetAt = now + targetMinutes`) is persisted immediately. When a terminal event occurs (`evaluateStops`), the engine executes an $O(1)$ comparison. **No background table sweeping is required.**

---

## Core Architecture & Design Patterns

The engine adheres strictly to **Hexagonal Architecture (Ports and Adapters)**:
- **Core Domain:** Zero external dependencies. Pure TypeScript state machine and condition evaluator.
- **Storage Port (`ISlaStorageDriver`):** Swappable persistence drivers (In-Memory for tests/serverless, Drizzle ORM for PostgreSQL transactions).
- **Audit Port (`ISlaAuditSink`):** Telemetry stream decoupled from storage (STDOUT, EventEmitter, Kafka, Slack).

```
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

### Design Patterns Applied:
- **Clock vs. Alarm:** Segregates measurement from alerting.
- **Strategy Pattern:** Dynamic matching of flexible JSONB rules via `ConditionEvaluator`.
- **In-Flight Mutex Barrier:** Suppresses concurrent duplicate triggers in microtasks and distributed workers.
- **Ports & Adapters:** Enables full testability without requiring live databases.

---

## Why This Stack (Engineering Rationale)

- **Pure TypeScript Core:** Zero runtime dependencies (`node_modules` size on core is 0 KB). Can execute in Node.js, Bun, Deno, AWS Lambda, or Cloudflare Workers.
- **PostgreSQL JSONB (`condition_payload`):** Eliminates Entity-Attribute-Value (EAV) table-join performance penalties while enabling custom, schema-free rule predicates (`{ "priority": "URGENT", "requireAllTasks": true }`).
- **Drizzle ORM Adapter:** Full TypeScript type inference with zero overhead, operating natively inside transactional contexts (`tx`).
- **NestJS Integration:** Provided as an optional dynamic module (`WatchdogSlaModule.forRoot()`) for enterprise codebases.

---

## Production Use Cases

### 1. Incident Management & Support Escalations
Guaranteed response times for critical P1 infrastructure outages and enterprise client SLAs.

### 2. Autonomous AI Agents & Tool-Calling Loops (Circuit Breaker)
LLM agents (e.g., LangChain, AutoGPT, CrewAI) often enter hallucinatory infinite loops or hang on slow web scrapers. `watchdog-sla-engine` serves as an **unforgeable temporal circuit-breaker**:

```typescript
// Enforce a strict 3-minute hard ceiling on AI sub-agent tool execution
await engine.evaluateTriggers({
  entityId: agentTaskId,
  entityType: 'ai_subagent',
  triggerEvent: 'AGENT_DISPATCHED',
  overrideTargetMinutes: 3,
  metadata: { model: 'claude-3-7-sonnet', tool: 'postgres_search' }
});

// Inside agent execution loop:
const telemetry = engine.calculateRemainingTime(activeTracker);
if (telemetry.isBreached) {
  throw new Error('SLA Circuit Breaker: Halting runaway autonomous agent loop.');
}
```

---

## Installation

```bash
npm install watchdog-sla-engine
```

*Optional peer dependencies for PostgreSQL / NestJS:*
```bash
npm install drizzle-orm pg @nestjs/common @nestjs/core
```

---

## Quickstart

### 1. Standalone / Zero-Dependency Mode

```typescript
import { 
  WatchdogSlaEngine, 
  InMemorySlaStorage, 
  ConsoleAuditSink 
} from 'watchdog-sla-engine';

const storage = new InMemorySlaStorage();
const auditSink = new ConsoleAuditSink();
const engine = new WatchdogSlaEngine({ storageDriver: storage, auditSink });

// 1. Register a policy (15-minute target)
await engine.createPolicy({
  name: 'P1 Incident Triage',
  entityType: 'incident',
  triggerEvent: 'INCIDENT_DECLARED',
  stopEvent: 'INCIDENT_ACKNOWLEDGED',
  targetMinutes: 15,
  isActive: true,
});

// 2. Start watchdog when incident is declared
await engine.evaluateTriggers({
  entityId: 'inc-9021',
  entityType: 'incident',
  triggerEvent: 'INCIDENT_DECLARED',
});

// 3. Stop watchdog when engineer acknowledges
const result = await engine.evaluateStops({
  entityId: 'inc-9021',
  entityType: 'incident',
  stopEvent: 'INCIDENT_ACKNOWLEDGED',
});

console.log(result.resolvedTrackers[0].tracker.status); // 'MET' or 'BREACHED'
console.log(result.resolvedTrackers[0].formattedDuration); // '12m 45s'
```

---

### 2. NestJS Module Registration

```typescript
import { Module } from '@nestjs/common';
import { WatchdogSlaModule, DrizzleSlaStorage } from 'watchdog-sla-engine';
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

## Running the Proof-of-Concept

The repository includes a self-contained, real-time simulation executing:
- **Scenario 1:** SLA Met within budget (Clean resolution).
- **Scenario 2:** SLA Breached due to operational delay (Overdue calculation).
- **Scenario 3:** Autonomous AI Agent tool-calling guardrail.
- **Scenario 4:** Microtask concurrent double-trigger deduplication.

To execute the proof of concept in 1 line:

```bash
npx tsx examples/run-simulation.ts
```

Or run the automated Vitest test suite:

```bash
npm test
```

---

## Deep Dive Documentation

For a comprehensive analysis of concurrency handling, race condition mitigation, and transactional guarantees, read:
👉 **[Architecture Deep Dive (`docs/ARCHITECTURE_DEEP_DIVE.md`)](file:///home/gustavo/Documentos/Code/watchdog-sla-engine/docs/ARCHITECTURE_DEEP_DIVE.md)**

---

## License

MIT © [Gustavo Grando](https://github.com/realgrando)
