/**
 * Watchdog SLA Engine
 * Deterministic event-driven SLA engine and lifecycle state machine for TypeScript and Node.js.
 * 
 * @author Gustavo Grando (@realgrando)
 * @license MIT
 */

// Core Contracts and Domain Ports
export * from './interfaces';

// Core State Machine & Evaluator
export * from './core/engine';
export * from './core/evaluator';

// In-Memory Storage Adapter (Zero-dependency driver)
export * from './adapters/memory/memory-storage';

// Audit Sinks
export * from './adapters/audit/console-audit-sink';
export * from './adapters/audit/event-emitter-audit-sink';

// Drizzle ORM PostgreSQL Adapter
export * from './adapters/drizzle';

// NestJS Module & Service Adapter
export * from './adapters/nestjs';
