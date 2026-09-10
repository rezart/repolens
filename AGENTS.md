# Repository Guidelines

## Subagent Model Preferences

- Use Sol (`gpt-5.6-sol`) for the code-reviewer agent.

## Project Structure & Module Organization

RepoLens indexes Git repositories into SQLite, answers codebase questions, and reviews GitHub pull requests. Backend TypeScript lives in `src/`: `indexer/`, `search/`, `query/`, `review/`, `llm/`, `embeddings/`, and `usage/` group domain logic. `src/server.ts` wires dependencies; `src/app.ts` defines the Hono API; `src/cli.ts` exposes commands. Tests mirror source modules under `tests/`. `web/` contains the vanilla JavaScript dashboard and static assets. Deployment files live in `deploy/`; integration instructions and design notes live in `docs/`. Generated databases and clones belong in ignored `data/`.

## Build, Test, and Development Commands

- `npm ci`: install locked dependencies.
- `cp .env.example .env`: initialize local configuration; edit before starting.
- `npm run dev`: run the server and dashboard with automatic reload.
- `npm start`: run without reload, defaulting to port 3000.
- `npm run cli -- index owner/name`: index a repository.
- `npm test`: run all Vitest tests.
- `npx vitest run tests/review`: run a focused test directory.
- `npm run typecheck`: check strict TypeScript without emitting files.
- `node --check web/app.js`: check dashboard JavaScript syntax.

There is no build step: `tsx` executes TypeScript directly.

## Coding Style & Naming Conventions

Match existing two-space indentation, single quotes, and semicolons. Use camelCase for functions and variables, PascalCase for types, and lowercase or kebab-case filenames. Use ESM imports with `.js` extensions for local TypeScript modules. Keep collaborators injectable and validate configuration through the existing Zod schema in `src/config.ts`. No formatter or linter is configured; follow surrounding code.

## Testing Guidelines

Name tests `tests/**/*.test.ts`, mirroring the source path. Use Vitest `describe`, `it`, and `expect`. Inject fake network and CLI implementations; use in-memory SQLite and temporary repositories where appropriate. Cover changed behavior and regressions. No coverage threshold is configured. Run tests and typechecking before submitting.

## Commit & Pull Request Guidelines

Follow history's Conventional Commit style, such as `feat(review): ...`, `fix(hook): ...`, or `docs: ...`. Follow `CLAUDE.md`: develop features and fixes in a separate worktree and branch, then open a PR against `main`. Describe the change and validation; link relevant issues and include screenshots for dashboard changes. RepoLens reviews are advisory: a failed, errored, pending, or missing `repolens/review` status must not block merging.

After creating a PR, stay with it until it is approved and ready to merge. Repeatedly check for new comments, review feedback, and required check results; address actionable feedback and continue monitoring after each push. Verify that approval applies to the latest commit, all required checks pass (excluding the advisory `repolens/review` status), and no unresolved merge blockers remain. Then ping the user with the PR link and confirmation that it is ready to merge; do not merge automatically.

## Security & Configuration

Never commit `.env`, tokens, databases, or cloned repositories. Refer to `.env.example` for supported settings. Preserve API authentication and webhook signature verification.
