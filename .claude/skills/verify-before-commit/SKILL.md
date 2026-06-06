---
name: verify-before-commit
description: Run BEFORE creating any git commit in this repo. Verifies that new functionality written during the session is covered by tests and that the existing test suite and build still pass. Use whenever the user asks to commit, or you are about to run `git commit` yourself.
---

# Verify before commit

A commit-time gate for conductor-linux. Before any `git commit`, make sure new
code from this session is tested and nothing already-working broke.

The project's only correctness gates are **`npm test`** (Vitest) and
**`npm run build`** (electron-vite / tsc). Tests live in `tests/`, mirroring
`src/` (`tests/main/**`, `tests/renderer/**`). There is no linter.

## When to run

Run this whole checklist when:
- the user says "commit", "закоміть", "зроби коміт", or similar, **or**
- you are about to run `git commit` for any reason.

Do **not** skip it because a change "looks trivial" — a one-line change to
`src/` can still break a test or leave new behavior uncovered.

## Steps

### 1. Find what changed in `src/`
```bash
git status --porcelain
git diff --stat HEAD
```
List the changed/added **source** files under `src/` (ignore files already in
`tests/`, config, docs). These are the candidates that need test coverage.

### 2. Check coverage for each changed source file
For every changed `src/...` file, find its test:
- `src/main/<x>.ts` → `tests/main/<x>.test.ts`
- `src/renderer/src/<x>.ts(x)` → `tests/renderer/<x>.test.ts(x)` or
  `tests/renderer/components/<x>.test.tsx`

For each new function, branch, or behavior added this session, confirm there is
a test asserting it. If coverage is **missing or incomplete**:
- Write the missing tests, following the patterns already in `tests/`:
  - mock `electron` / `node-pty` / `fs` via `vi.mock` + `vi.hoisted`
  - use real temp git repos (`tests/helpers/tempRepo.ts`) for `git.ts`
  - use `tests/helpers/fakePty.ts` for PTY logic
  - renderer tests use `// @vitest-environment jsdom` and
    `tests/renderer/helpers.ts` (`setupRenderer`, `makeApi`, `mkWs`)
- Cover the happy path **and** the error/edge branches (the existing suite tests
  both — e.g. unknown ids, thrown scripts, empty input).
- If a behavior is genuinely not unit-testable, say so explicitly and explain
  why — don't silently skip it.

### 3. Run the full suite (catch regressions)
```bash
npm test
```
All tests must pass. If any **previously passing** test now fails:
- Decide whether the change is a real regression (fix the code) or an
  intentional behavior change (update the test **and** point the change out to
  the user — never quietly rewrite an assertion to make red go green).

### 4. Typecheck / build
```bash
npm run build
```
Must succeed. This is the only type-safety gate; tests run through esbuild and
do **not** typecheck.

### 5. Report, then commit
Only after steps 1–4 are green, summarize:
- which source files changed and which tests now cover them,
- new test count and that `npm test` + `npm run build` pass.

Then create the commit. If the user did not explicitly ask to commit, confirm
first. (Per repo convention, branch off `main` first if you're on it, and end
the commit message with the required `Co-Authored-By` trailer.)

## Hard rules
- **Never commit with a failing `npm test` or `npm run build`.** If you can't get
  to green, stop and tell the user what's red and why.
- **Never** disable, `.skip`, or delete a failing test just to pass the gate.
- New behavior without a test is not done — add the test or flag it explicitly.
