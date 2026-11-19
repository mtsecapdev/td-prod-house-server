-- Hiding figures had no use case: figures are either kept or deleted.
ALTER TABLE figures DROP COLUMN IF EXISTS hidden;
