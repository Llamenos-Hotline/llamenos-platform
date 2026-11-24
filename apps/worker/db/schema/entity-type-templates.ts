/**
 * entity_type_templates — shipped and hub-customized entity type templates.
 * Builtin templates (isBuiltin=true) are seeded by the server on startup.
 * Hub admins apply templates to create hub-specific entity type instances.
 */
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

export const entityTypeTemplates = pgTable(
  'entity_type_templates',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    templateKey: text('template_key').notNull(),  // e.g. 'builtin:event', 'builtin:case'
    version: text('version').notNull().default('1.0.0'),
    category: text('category').notNull(),         // 'case' | 'event' | 'incident_report' | 'contact_note'
    isBuiltin: boolean('is_builtin').notNull().default(true),
    // Encrypted with hub key (LABEL_ENTITY_TYPE_DEFINITION)
    // null for builtin templates which are plaintext in code
    encryptedDefinition: text('encrypted_definition'),
    definitionEnvelope: jsonb('definition_envelope'),
    // Plaintext summary fields needed for server-side routing
    name: text('name').notNull(),
    icon: text('icon'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [
    cryptoFormatCheck('entity_type_templates', table.cryptoFormat),
    index('entity_type_templates_template_key_idx').on(table.templateKey),
    index('entity_type_templates_category_idx').on(table.category),
  ],
)
