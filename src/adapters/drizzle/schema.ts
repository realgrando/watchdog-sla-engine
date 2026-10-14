/**
 * Drizzle ORM Schema definition for Watchdog SLA Engine
 * PostgreSQL-compatible, domain-agnostic table definitions and relations.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const slaPolicies = pgTable(
  'sla_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    entityType: varchar('entity_type', { length: 100 }),
    scopeId: varchar('scope_id', { length: 255 }),
    targetScopeId: varchar('target_scope_id', { length: 255 }),
    triggerEvent: varchar('trigger_event', { length: 100 }).notNull(),
    stopEvent: varchar('stop_event', { length: 100 }).notNull(),
    targetMinutes: integer('target_minutes').notNull(),
    conditionPayload: jsonb('condition_payload'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('idx_sla_policies_trigger_active').on(table.triggerEvent, table.isActive),
    index('idx_sla_policies_entity_type').on(table.entityType),
  ]
);

export const slaTrackers = pgTable(
  'sla_trackers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => slaPolicies.id, { onDelete: 'cascade' }),
    entityId: varchar('entity_id', { length: 255 }).notNull(),
    entityType: varchar('entity_type', { length: 100 }),
    status: varchar('status', { length: 50 }).notNull().default('ACTIVE'),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    targetAt: timestamp('target_at').notNull(),
    stoppedAt: timestamp('stopped_at'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_sla_trackers_entity_status').on(table.entityId, table.status),
    index('idx_sla_trackers_policy_status').on(table.policyId, table.status),
    index('idx_sla_trackers_target_at').on(table.targetAt),
  ]
);

export const slaPoliciesRelations = relations(slaPolicies, ({ many }) => ({
  trackers: many(slaTrackers),
}));

export const slaTrackersRelations = relations(slaTrackers, ({ one }) => ({
  policy: one(slaPolicies, {
    fields: [slaTrackers.policyId],
    references: [slaPolicies.id],
  }),
}));
