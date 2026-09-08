import assert from "node:assert/strict";
import test from "node:test";

import type { DistillationSessionItem } from "../index.ts";
import {
  filterDistillationSessions,
  groupDistillationSessionsByProject,
  materialKeyOf,
  toggleMaterialSelection,
  toggleProjectSelection,
} from "./materials.ts";

function session(
  sessionId: string,
  startedAt: string,
  overrides: Partial<DistillationSessionItem> = {},
): DistillationSessionItem {
  return {
    source: "codex",
    sessionId,
    title: sessionId,
    projectKey: "sample-project",
    isGitProject: true,
    model: null,
    startedAt,
    endedAt: startedAt,
    turns: 1,
    status: "available",
    ...overrides,
  };
}

// Local-date helpers: `filterDistillationSessions` buckets by the *machine's*
// local day boundaries, so fixtures must be built from local date parts
// instead of a hardcoded offset, otherwise the assertions shift when the
// suite runs in another timezone (e.g. UTC on CI).
function atLocal(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

const NOW = new Date(2026, 7, 12, 14, 0);

test("filterDistillationSessions applies today and rolling ranges to real timestamps", () => {
  const sessions = [
    session("today", atLocal(2026, 8, 12, 0, 5)),
    session("seven-days", atLocal(2026, 8, 6, 23, 59)),
    session("thirty-days", atLocal(2026, 7, 14, 8, 0)),
    session("outside", atLocal(2026, 7, 13, 23, 59)),
    session("future", atLocal(2026, 8, 13, 0, 0)),
    session("legacy", "not-a-timestamp"),
  ];

  assert.deepEqual(
    filterDistillationSessions(sessions, "today", NOW).map(
      (item) => item.sessionId,
    ),
    ["today"],
  );
  assert.deepEqual(
    filterDistillationSessions(sessions, "7", NOW).map(
      (item) => item.sessionId,
    ),
    ["today", "seven-days"],
  );
  assert.deepEqual(
    filterDistillationSessions(sessions, "30", NOW).map(
      (item) => item.sessionId,
    ),
    ["today", "seven-days", "thirty-days"],
  );
  assert.equal(filterDistillationSessions(sessions, "all", NOW).length, 6);
});

test("toggleMaterialSelection adds and removes without a count limit", () => {
  const full = new Set(["a", "b", "c", "d"]);
  // Adding beyond the old 8-cap still succeeds.
  assert.deepEqual(
    [...toggleMaterialSelection(full, "e")],
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual([...toggleMaterialSelection(full, "a")], ["b", "c", "d"]);
  // Toggling the same key twice returns the original set (stable identity).
  const once = toggleMaterialSelection(full, "e");
  assert.deepEqual([...toggleMaterialSelection(once, "e")], [...full]);
});

test("toggleProjectSelection is atomic and accumulates without a limit", () => {
  assert.deepEqual(
    [...toggleProjectSelection(new Set(), ["p:1", "p:2", "p:2"])],
    ["p:1", "p:2"],
  );
  assert.deepEqual(
    [...toggleProjectSelection(new Set(["p:1", "p:2"]), ["p:1", "p:2"])],
    [],
  );
  // A project larger than the old 8-cap still selects in full.
  const many = Array.from({ length: 12 }, (_, i) => `p:${i + 1}`);
  assert.deepEqual([...toggleProjectSelection(new Set(), many)], many);
});

test("groupDistillationSessionsByProject merges same-named projects across sources", () => {
  const groups = groupDistillationSessionsByProject([
    session("codex-a", "2026-08-12T10:00:00+08:00"),
    session("codex-b", "2026-08-12T11:00:00+08:00"),
    session("claude-a", "2026-08-12T12:00:00+08:00", {
      source: "claude-code",
    }),
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups.map((group) => [
      group.key,
      group.sessions.length,
      group.sources,
      group.last,
    ]),
    [
      [
        "sample-project",
        3,
        ["codex", "claude-code"],
        "2026-08-12T12:00:00+08:00",
      ],
    ],
  );
  assert.equal(materialKeyOf(groups[0]!.sessions[0]!), "codex:codex-a");
});

test("groupDistillationSessionsByProject only groups git-backed sessions", () => {
  const groups = groupDistillationSessionsByProject([
    session("git-a", "2026-08-12T10:00:00+08:00"),
    session("git-b", "2026-08-12T11:00:00+08:00"),
    // A plain folder (scanner found no repository): selectable by session but
    // never a project.
    session("folder-c", "2026-08-12T12:00:00+08:00", {
      projectKey: "plain-folder",
      isGitProject: false,
    }),
    // Legacy session with no git flag defaults to non-project too.
    session("legacy-d", "2026-08-12T13:00:00+08:00", {
      projectKey: "legacy-folder",
      isGitProject: undefined,
    }),
  ]);

  assert.deepEqual(
    groups.map((group) => [group.key, group.sessions.length]),
    [["sample-project", 2]],
  );
});
