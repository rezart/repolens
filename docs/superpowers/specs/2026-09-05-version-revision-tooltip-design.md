# Running Revision Tooltip

## Goal

Show the exact Git commit served by the running RepoLens container when a user hovers over the existing version number in the top-left brand area. Keep the visible version text unchanged.

## Design

The deploy workflow passes `github.sha` to the Docker build as `REPOLENS_REVISION`. The Dockerfile stores that build argument as an image environment variable, so the value follows the immutable image and does not require Docker socket access or a production `.env` change.

RepoLens reads the optional variable through its existing configuration loader and returns it as `revision` from the unauthenticated `/api/health` response. The dashboard already uses that response to render `v0.1.0`; it will set the version element's native `title` attribute to the full revision when present. When the value is absent in local development, the dashboard omits the tooltip.

## Error Handling and Security

`REPOLENS_REVISION` is optional and trimmed. Missing or blank values produce `revision: null` and no tooltip. A commit SHA is public deployment metadata and adds no credential exposure. The application receives no Docker API access.

## Verification

- Configuration and health-route tests cover populated and absent revisions.
- A dashboard test verifies the full revision is assigned to the version element tooltip while the visible version stays unchanged.
- Run the full Vitest suite, TypeScript typecheck, and `node --check web/app.js`.
- After merge, verify the Deploy workflow succeeds and the public health response and tooltip contain the exact deployed OCI revision.
