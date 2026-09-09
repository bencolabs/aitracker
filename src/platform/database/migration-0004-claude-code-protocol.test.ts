/**
 * Migration 0004 must widen `model_profiles.protocol` without losing data.
 *
 * The rebuild drops a table that three others reference, so the interesting
 * assertions are not "does claude-code insert" but "did the referential
 * actions fire and quietly take history with them".
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DatabaseHost } from "./database-host.server.ts";
import type { RuntimeVersionsProvider } from "./capability-probe.server.ts";
import { runMigrations } from "./migration-runner.server.ts";
import { MIGRATIONS } from "./migrations/index.ts";

const APP_VERSION = "test-version";
const BEFORE_0004 = MIGRATIONS.filter((migration) => migration.version <= 3);

interface TestScope {
  after(fn: () => void): void;
}

function versionsProvider(): RuntimeVersionsProvider {
  return {
    getVersions: () => ({ nodeVersion: "24.19.0", sqliteVersion: "99.0.0" }),
  };
}

function openHost(scope: TestScope): DatabaseHost {
  const directory = mkdtempSync(join(tmpdir(), "aitracker-db-mig0004-"));
  const host = DatabaseHost.open({
    path: join(directory, "platform.db"),
    versionsProvider: versionsProvider(),
  });
  scope.after(() => host.close());
  scope.after(() => {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best effort; Windows may hold a handle briefly after close.
    }
  });
  return host;
}

/** Brings a host to schema version 3 and seeds a profile with every referrer. */
function seedAtVersion3(host: DatabaseHost): void {
  runMigrations({
    database: host,
    appVersion: APP_VERSION,
    definitions: BEFORE_0004,
  });
  host.exec(`
    INSERT INTO secure_secrets
      (secret_id, purpose, ciphertext, encryption_kind, created_at_ms, updated_at_ms)
    VALUES ('secret-1', 'model-api-key', x'000102030405060708090a0b0c0d0e0f', 'keychain', 10, 10);

    INSERT INTO model_profiles
      (profile_id, name, mode, protocol, endpoint, model, auth, secret_id,
       is_active, created_at_ms, updated_at_ms)
    VALUES ('profile-1', 'Existing', 'custom', 'anthropic',
            'https://api.anthropic.com/v1', 'claude-sonnet-5', 'x-api-key',
            'secret-1', 1, 20, 20);

    INSERT INTO ai_executions
      (request_id, capability, profile_id, prompt_version_id, prompt_version, status)
    VALUES ('req-1', 'report', 'profile-1', 'prompt.v1', 1, 'completed');

    INSERT INTO insight_preferences
      (scope_key, mode, profile_id, updated_at_ms)
    VALUES ('scope-1', 'enhanced-manual', 'profile-1', 30);

    INSERT INTO insight_enhancement_cache
      (cache_key, surface_id, scope_hash, evidence_hash, locale, profile_id,
       generated_at_ms, expires_at_ms, status)
    VALUES ('cache-1', 'dashboard', 'scope-hash', 'evidence-hash', 'en-US',
            'profile-1', 40, 99999, 'ready');
  `);
}

function scalar(host: DatabaseHost, sql: string): unknown {
  const row = host.prepare(sql).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

/** node:sqlite returns counts as bigint; normalise before comparing. */
function count(host: DatabaseHost, sql: string): number {
  return Number(scalar(host, sql));
}

test("0004 admits the claude-code protocol", (t) => {
  const host = openHost(t as TestScope);
  seedAtVersion3(host);

  runMigrations({ database: host, appVersion: APP_VERSION });

  host.exec(`
    INSERT INTO model_profiles
      (profile_id, name, mode, protocol, is_active, created_at_ms, updated_at_ms)
    VALUES ('profile-cc', 'Local Claude Code', 'custom', 'claude-code', 0, 50, 50);
  `);
  assert.equal(
    scalar(
      host,
      "SELECT protocol FROM model_profiles WHERE profile_id = 'profile-cc'",
    ),
    "claude-code",
  );
});

test("0004 still rejects an unknown protocol", (t) => {
  const host = openHost(t as TestScope);
  seedAtVersion3(host);
  runMigrations({ database: host, appVersion: APP_VERSION });

  assert.throws(() =>
    host.exec(`
      INSERT INTO model_profiles
        (profile_id, name, mode, protocol, is_active, created_at_ms, updated_at_ms)
      VALUES ('profile-bad', 'Bogus', 'custom', 'not-a-protocol', 0, 60, 60);
    `),
  );
});

test("0004 preserves the profile row and every reference to it", (t) => {
  const host = openHost(t as TestScope);
  seedAtVersion3(host);

  runMigrations({ database: host, appVersion: APP_VERSION });

  // The profile itself, with each column carried across the rebuild.
  const profile = host
    .prepare("SELECT * FROM model_profiles WHERE profile_id = 'profile-1'")
    .get() as Record<string, unknown>;
  assert.equal(profile.name, "Existing");
  assert.equal(profile.protocol, "anthropic");
  assert.equal(profile.endpoint, "https://api.anthropic.com/v1");
  assert.equal(profile.model, "claude-sonnet-5");
  assert.equal(profile.auth, "x-api-key");
  assert.equal(profile.secret_id, "secret-1");

  // ON DELETE SET NULL would have blanked these two.
  assert.equal(
    scalar(
      host,
      "SELECT profile_id FROM ai_executions WHERE request_id = 'req-1'",
    ),
    "profile-1",
    "ai_executions attribution must survive the rebuild",
  );
  assert.equal(
    scalar(
      host,
      "SELECT profile_id FROM insight_preferences WHERE scope_key = 'scope-1'",
    ),
    "profile-1",
    "the user's per-scope profile choice must survive the rebuild",
  );

  // ON DELETE CASCADE would have deleted this row outright.
  assert.equal(
    scalar(
      host,
      "SELECT profile_id FROM insight_enhancement_cache WHERE cache_key = 'cache-1'",
    ),
    "profile-1",
    "cached enhancements must survive the rebuild",
  );
});

test("0004 restores the view, the single-active index, and leaves no scratch tables", (t) => {
  const host = openHost(t as TestScope);
  seedAtVersion3(host);

  runMigrations({ database: host, appVersion: APP_VERSION });

  assert.equal(
    scalar(host, "SELECT profile_id FROM v_active_model_profile"),
    "profile-1",
    "v_active_model_profile must be recreated over the rebuilt table",
  );

  // A second active profile must still be impossible.
  assert.throws(
    () =>
      host.exec(`
        INSERT INTO model_profiles
          (profile_id, name, mode, protocol, is_active, created_at_ms, updated_at_ms)
        VALUES ('profile-2', 'Second active', 'custom', 'claude-code', 1, 70, 70);
      `),
    "idx_model_profiles_single_active must be recreated",
  );

  assert.equal(
    count(
      host,
      "SELECT count(*) FROM sqlite_master WHERE name LIKE '\\_mig0004\\_%' ESCAPE '\\'",
    ),
    0,
    "migration scratch tables must not survive the transaction",
  );
});
