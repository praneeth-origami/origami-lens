-- 002_components.sql already created component_generation_status without
-- CANCELLED in any environment that has already migrated — ALTER TYPE is
-- required to add the value to an existing enum type (re-running CREATE TYPE
-- inside the duplicate_object guard is a no-op once the type exists).
ALTER TYPE component_generation_status ADD VALUE IF NOT EXISTS 'CANCELLED';
