# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This checkout is a fork

`origin` is `bencolabs/aitracker`; `upstream` is `estelwalks/aitracker`.

- `main` is a read-only mirror of upstream. Never commit to it — once it carries
  a local commit, `git pull upstream main` stops being a fast-forward.
- `dev` is where local work happens and where builds are cut from.
- Syncing: `git checkout main && git pull upstream main && git push origin main`,
  then `git checkout dev && git rebase main && git push --force-with-lease`.

`dev` currently carries two local commits on top of upstream v1.0.1:

- `fix:` moves the secret key from `<dataRoot>/secure/secrets.key` into
  `<dataRoot>/<APP_DATA_DIR>/secure/`, and makes the dashboard-insight redaction
  match `~/`-prefixed project paths (the usage scanner normalises paths to `~/`
  before redaction ever sees them, so the original regex never fired for
  projects under `$HOME`). Upstream-suitable.
- `feat(local):` appends `.claude/plugins/marketplaces/ecc/skills` as a
  discovery-only skill root for `claude-code`. Hardcodes one marketplace name —
  local only, do not offer upstream. The general fix is upstream issues #26/#28.

## Environment

Node 24+ is required and enforced (`engines`). The app uses the built-in
`node:sqlite`, which is why 22 will not do; there is no native SQLite dependency
to compile. If `npm ci` leaves `node_modules/electron/dist` missing, npm's
`allowScripts` gate skipped the postinstall — run `node node_modules/electron/install.js`.

## Commands

`docs/DEVELOPMENT.md` has the full command matrix and packaging flow. Day to day:

```bash
npm run dev:desktop     # Electron + Vite on 127.0.0.1:5173
npm run test:all        # unit + scripts + database + scanner
npm run typecheck       # app and Electron projects, both must pass
npm run dist:mac:arm64  # local .app + DMG in release/
```

Single test file, and a single test within it:

```bash
node --import tsx --test src/lib/i18n/locale.test.ts
node --import tsx --test --test-name-pattern "redacts" src/modules/dashboard/ai-insight.server.test.ts
```

Without a Developer ID certificate, `after-pack.cjs` falls back to an ad-hoc
signature. A locally built `.app` carries no quarantine attribute, so it runs
without a Gatekeeper prompt on the machine that built it — and only there.

Only one instance may hold the database at a time (`aitracker.v1.db.writer.lock`).
Quit a running `/Applications/AITracker.app` before `npm run dev:desktop`.

## Architecture

Modular monolith. A TanStack Start app and an Electron shell share one SQLite
database; the renderer reaches server code only through server functions.

- `src/app/` — composition root. `composition.server.ts` wires every port and
  is the only place that knows concrete adapters. Read it first.
- `src/modules/<domain>/` — business modules in `application/`, `infrastructure/`,
  `presentation/`, plus a `contracts.ts`. 17 of them, catalogued in
  `module-catalog.source.json` (navigation, capabilities, platform support).
- `src/lib/` — cross-cutting libraries. `tool-registry/` is the single source of
  truth for every supported AI tool; `local-usage/` and `local-sessions/` are the
  log scanners; also `pricing/`, `local-skills/`, `i18n/`.
- `src/platform/` — infrastructure: `database/` (migrations, backup, recovery),
  `discovery/`, `observability/`, `snapshot-runtime/`.
- `electron/` — main process: window and IPC, the loopback web server, the
  security scanner service, the update manager.

### Declarative facts, generated code

Tool support, pricing, security rules, runtime policy and the module catalog are
JSON/source definitions compiled into committed `*.generated.ts` files. Never
hand-edit a generated file: change the definition, run the matching
`npm run generate:*` (or `npm run prebuild` for all of them), and the paired
`npm run verify:*` proves the two still agree in CI.

Adding a tool means adding `src/lib/tool-registry/definitions/<id>.tool.json` —
detection paths, usage reader, skill roots, session resume command — not writing
imperative code.

### Boundaries, enforced by scripts

`verify:browser-server-boundary` and `verify:architecture` are gates, not advice:

- `*.server.ts` must never be statically imported by browser-safe code (routes,
  `presentation/`, query facades, components); nor may `node:*` builtins. Dynamic
  imports inside a `.server.ts` are fine — that is why `composition.server.ts` is
  reached through `await import(...)` in server functions.
- `src/modules/**` must not import `node:sqlite`; business logic reaches storage
  through a platform repository/port. Inside `src/platform/database/**` only
  `infrastructure/**` may touch the driver.
- No deep imports across modules — go through a module's public entry. Routes
  must not import server modules directly.

### Frozen contracts

`src/lib/tool-registry/__baseline__/baseline.ts` is a frozen pre-migration
snapshot and is documented as immutable. When an intentional change diverges from
it, do not edit the baseline to make the test pass: add a narrow exception in
`baseline.test.ts` with an `Expected diff (...)` comment explaining why, as done
for workbuddy, pi and omp.

### Privacy is an architectural constraint

`src/app/runtime-policy.source.json` marks each snapshot `network: "allowed"` or
`"forbidden"`. Everything derived from local logs — usage, sessions, skills,
tool installations — is `forbidden`, and `verify:runtime-policy` enforces it.
Only exchange rates and skill-market evidence may reach the network.

Consequences when editing: scanned local data must not gain a network path;
anything sent to a model provider goes through an explicit allowlisted projection
(see `toDashboardAIInsightInput`, which ships aggregates and top-3 labels only);
`PRIVACY.md` documents the outbound surface and must stay true. `verify:sqlite-only`
and `verify:bundle-no-sqlite` are blocking release gates.

Known upstream defect: `allowlist projection strips an unexpected path-like project
label` in `ai-insight.server.test.ts` fails on v1.0.0 and v1.0.1 alike (its fixture
pins `2026-08-10` against a 30-day window). It is unrelated to local changes — do
not treat a red `test:unit` from that one case as a regression, and do not "fix" it
by loosening the assertion.
