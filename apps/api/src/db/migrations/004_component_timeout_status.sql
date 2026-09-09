-- Adds TIMED_OUT as its own terminal status, distinct from both FAILED (a
-- genuine model/network/worker error) and CANCELLED (the user asked for it)
-- -- see 003_component_cancelled_status.sql for why ALTER TYPE (not
-- CREATE TYPE) is required on an already-migrated database.
ALTER TYPE component_generation_status ADD VALUE IF NOT EXISTS 'TIMED_OUT';

-- Internal-only failure classification (AI_UNAVAILABLE, PAYLOAD_TOO_LARGE,
-- MODEL_TIMEOUT, USER_CANCELLED, CLIENT_DISCONNECTED, MODEL_ERROR,
-- NETWORK_ERROR, WORKER_ERROR, QUEUE_ERROR) — never shown verbatim to end
-- users; `error` remains the safe, generic user-facing message. Lets future
-- diagnosis and observability distinguish these without misreading
-- aiAvailable=false as an AI-health signal when the real cause was, say, a
-- body-size limit or a cancellation.
ALTER TABLE component_jobs ADD COLUMN IF NOT EXISTS error_category TEXT;
