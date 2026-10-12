# Loop engineering

This repository is wired for an autonomous **verify-until-green** agent loop.
Two halves make it work: a local/CI verifier, and a repo-level "outer loop" that
addresses PR review feedback automatically on every future PR.

## Inner loop: the verifier

- `npm run verify` runs, failing fast and in CI order: architecture checks,
  `@machbar/shared` build, typecheck, tests, and the production build.
- `bash scripts/verify.sh` (also `npm run verify:all`) runs `npm run verify`
  followed by `python -m pytest` for the Home Assistant integration.
- None of these need a running server: vitest is in-process, the API uses an
  embedded `better-sqlite3` file, and the Python tests use the in-process
  `pytest-homeassistant-custom-component` harness. Playwright e2e self-starts a
  server via `playwright.config.ts` and is deliberately kept out of this loop.
- `scripts/codex-setup.sh` installs everything the offline loop needs
  (`npm ci`, then the Python test requirements). It is idempotent.

## Outer loop: auto-address review feedback

[`.github/workflows/codex-address-review.yml`](../.github/workflows/codex-address-review.yml)
is the durable glue that makes the review→fix loop run going forward, without
anyone re-prompting per PR. It uses the official
[OpenAI Codex Action](https://github.com/openai/codex-action)
(`openai/codex-action`, pinned to a release SHA).

### What triggers it

- A submitted pull request review whose state is `changes_requested` or
  `commented`.
- An on-demand `@codex` mention in a PR comment (`issue_comment`) or an inline
  review comment (`pull_request_review_comment`).

### What it does

1. Rejects fork PRs (so secrets are never exposed to untrusted code) and checks
   out the PR head branch.
2. Collects the PR's reviews and inline review comments for Codex to read.
3. Installs dependencies, then runs Codex with the `:workspace` permission
   profile to make the minimal changes that address the feedback.
4. Runs `bash scripts/verify.sh` before pushing. Only a green result is pushed
   back to the PR branch. If verification still fails after
   `MAX_VERIFY_ATTEMPTS` (mirroring the iteration cap in `AGENTS.md`), it stops
   and leaves a PR comment instead of force-pushing broken code.

Permissions are least-privilege (`contents: write`, `pull-requests: write`
only), runs are serialized per PR via a concurrency group, and the Codex Action
additionally enforces that the triggering actor has write access.

### One-time setup (required)

1. **Add the repo secret `OPENAI_API_KEY`** (Settings → Secrets and variables →
   Actions). The workflow references `${{ secrets.OPENAI_API_KEY }}`; it is never
   hardcoded. This is the key the Codex Action needs.
2. **Enable Codex auto-review on every PR in the Codex cloud UI.** That setting
   is not a repository file. It is what makes Codex *generate* a review on each
   PR; this workflow is the side that *reacts* to review feedback and pushes
   verified fixes.
   - If you want this workflow to also react to the Codex cloud reviewer's bot
     reviews (not just human reviewers and `@codex` mentions), add that bot to
     the Codex Action's `allow-bot-users` input.

### How this differs from the app's per-PR Agent merge

The GitHub Copilot app's "Agent merge" is a per-PR toggle that shepherds a
single pull request. This workflow is repo-level and durable: once the secret
and cloud setting are in place, the review→fix→verify→push loop runs on every
future PR with no per-PR action.
