/**
 * Migration 0004: allow the `claude-code` model protocol.
 *
 * The protocol column is guarded by a CHECK constraint, and SQLite cannot
 * alter one in place — the table has to be rebuilt. Three tables reference
 * `model_profiles`, and the runner executes migrations inside a transaction
 * with `PRAGMA foreign_keys=ON` (which cannot be disabled mid-transaction), so
 * dropping the table fires their referential actions:
 *
 * - `ai_executions.profile_id`      ON DELETE SET NULL  — attribution cleared
 * - `insight_preferences.profile_id` ON DELETE SET NULL — user choice cleared
 * - `insight_enhancement_cache`      ON DELETE CASCADE  — rows deleted outright
 *
 * Letting those fire would silently discard execution history, the user's
 * per-scope profile selection, and the enhancement cache. Instead every
 * affected value is snapshotted into a scratch table first and restored once
 * the rebuilt `model_profiles` rows exist again, so the migration is
 * value-preserving end to end. The scratch tables are dropped before commit.
 */
export const CLAUDE_CODE_PROTOCOL_SQL = `-- AITracker local storage database — widen model_profiles.protocol.

-- 1. Snapshot every value the drop's referential actions would clear.
CREATE TABLE _mig0004_model_profiles AS SELECT * FROM model_profiles;
CREATE TABLE _mig0004_ai_executions AS
  SELECT request_id, profile_id FROM ai_executions WHERE profile_id IS NOT NULL;
CREATE TABLE _mig0004_insight_preferences AS
  SELECT scope_key, profile_id FROM insight_preferences WHERE profile_id IS NOT NULL;
CREATE TABLE _mig0004_insight_cache AS SELECT * FROM insight_enhancement_cache;

-- 2. Rebuild the table with the widened protocol CHECK.
DROP VIEW v_active_model_profile;
DROP TABLE model_profiles;

CREATE TABLE model_profiles (
  profile_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  mode TEXT NOT NULL DEFAULT 'custom' CHECK (
    mode IN ('official', 'custom')
  ),
  protocol TEXT NOT NULL CHECK (
    protocol IN ('openai', 'openai-responses', 'anthropic', 'claude-code')
  ),
  endpoint TEXT,
  model TEXT,
  auth TEXT CHECK (auth IS NULL OR auth IN ('x-api-key', 'bearer')),
  secret_id TEXT REFERENCES secure_secrets (secret_id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

INSERT INTO model_profiles (
  profile_id, name, mode, protocol, endpoint, model, auth, secret_id,
  is_active, created_at_ms, updated_at_ms
)
SELECT profile_id, name, mode, protocol, endpoint, model, auth, secret_id,
       is_active, created_at_ms, updated_at_ms
FROM _mig0004_model_profiles;

CREATE UNIQUE INDEX idx_model_profiles_single_active
  ON model_profiles (is_active) WHERE is_active = 1;

CREATE VIEW v_active_model_profile AS
SELECT profile_id, name, mode, protocol, endpoint, model, is_active, created_at_ms, updated_at_ms
FROM model_profiles WHERE is_active = 1;

-- 3. Restore every reference the drop cleared.
UPDATE ai_executions SET profile_id = (
  SELECT s.profile_id FROM _mig0004_ai_executions s
  WHERE s.request_id = ai_executions.request_id
) WHERE request_id IN (SELECT request_id FROM _mig0004_ai_executions);

UPDATE insight_preferences SET profile_id = (
  SELECT s.profile_id FROM _mig0004_insight_preferences s
  WHERE s.scope_key = insight_preferences.scope_key
) WHERE scope_key IN (SELECT scope_key FROM _mig0004_insight_preferences);

INSERT INTO insight_enhancement_cache (
  cache_key, surface_id, scope_hash, evidence_hash, locale, profile_id,
  prompt_version_id, prompt_version, model_label, ai_request_id,
  generated_at_ms, expires_at_ms, status
)
SELECT cache_key, surface_id, scope_hash, evidence_hash, locale, profile_id,
       prompt_version_id, prompt_version, model_label, ai_request_id,
       generated_at_ms, expires_at_ms, status
FROM _mig0004_insight_cache;

DROP TABLE _mig0004_model_profiles;
DROP TABLE _mig0004_ai_executions;
DROP TABLE _mig0004_insight_preferences;
DROP TABLE _mig0004_insight_cache;
`;
