-- Keep the work-log exclusion-constraint extension out of the public API schema.
-- Relocation preserves existing constraints and data (Postgres tracks dependencies by OID).
create schema if not exists extensions;
alter extension btree_gist set schema extensions;
