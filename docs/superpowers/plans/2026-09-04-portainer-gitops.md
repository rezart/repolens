# Portainer GitOps Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish RepoLens from `main` to GHCR and trigger a path-restricted Portainer deployment webhook.

**Architecture:** GitHub Actions builds the image before invoking Portainer. Portainer owns the runtime container through a Git-backed Compose stack while Cloudflare exposes only its generated webhook path.

**Tech Stack:** Docker Compose, GitHub Actions, GHCR, Portainer CE, Cloudflare Tunnel

**Spec:** `docs/superpowers/specs/2026-09-04-portainer-gitops-design.md`

## Global Constraints

- Preserve `/opt/repolens/.env`, `repolens-data`, `192.168.7.195:3010`, and `repolens.betalabs.org`.
- Do not store runtime credentials in Git or expose the Portainer dashboard.
- Do not invoke the deployment webhook until the image has been published successfully.

---

### Task 1: Production deployment contract

**Files:**
- Create: `deploy/docker-compose.production.yml`

**Interfaces:**
- Consumes: `/opt/repolens/.env`, external volume `repolens-data`, image `ghcr.io/rezart/repolens:main`
- Produces: one Portainer-compatible `repolens` service on `192.168.7.195:3010`

- [ ] **Step 1: Add the minimal Compose service**

Define the GHCR image, read-only environment bind mount, persistent external data volume, restart policy, fixed port, and Node-based health check.

- [ ] **Step 2: Validate the Compose model**

Run: `docker compose -f deploy/docker-compose.production.yml config`

Expected: exit 0 with one `repolens` service and `repolens-data` marked external.

### Task 2: Publish and deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: the merge commit, `GITHUB_TOKEN`, and `PORTAINER_WEBHOOK_URL`
- Produces: `ghcr.io/rezart/repolens:main`, then one webhook POST

- [ ] **Step 1: Add the image workflow**

Trigger on pushes to `main`, refuse manual runs for any other ref, grant `contents: read` and `packages: write`, log in to GHCR, and build and push the repository Dockerfile under `main` and immutable commit tags.

- [ ] **Step 2: Add the guarded deployment request**

Expose `secrets.PORTAINER_WEBHOOK_URL` only to the deployment step, then POST with `curl --fail --retry 3` after the image push.

- [ ] **Step 3: Validate repository behavior**

Run: `npm test && npm run typecheck`

Expected: 444 tests pass and TypeScript exits 0.

### Task 3: Merge and bootstrap Portainer

**Files:**
- Runtime only; no repository files

**Interfaces:**
- Consumes: merged workflow and production Compose file
- Produces: public GHCR image and Git-backed Portainer stack

- [ ] **Step 1: Commit, push, and open a PR**

Use commit `feat(deploy): automate Portainer deployments`, wait for `repolens/review` success, and merge into `main`.

- [ ] **Step 2: Verify the bootstrap image**

Confirm the merge workflow succeeds, explicitly change the new GHCR package visibility to public, and verify `ghcr.io/rezart/repolens:main` is pullable anonymously from `external-docker`.

- [ ] **Step 3: Migrate the runtime**

Stop and remove only the existing `repolens` container, create a Portainer Git stack named `repolens` from `https://github.com/rezart/repolens.git`, reference `refs/heads/main`, and use `deploy/docker-compose.production.yml`.

- [ ] **Step 4: Enable GitOps webhook updates**

Enable the stack webhook, re-pull images, and force redeployment when the webhook runs. Record the generated webhook path.

### Task 4: Restricted webhook route and final verification

**Files:**
- Runtime only; no repository files

**Interfaces:**
- Consumes: Portainer webhook path
- Produces: Cloudflare route and GitHub Actions secret `PORTAINER_WEBHOOK_URL`

- [ ] **Step 1: Add the Cloudflare route**

Publish `portainer-webhook.betalabs.org` only for the generated webhook path and route it to `https://192.168.7.195:9443` with origin certificate verification disabled.

- [ ] **Step 2: Store the webhook URL**

Set repository secret `PORTAINER_WEBHOOK_URL` to the public path-restricted HTTPS URL.

- [ ] **Step 3: Exercise the deployment**

Trigger the workflow manually on `main`, confirm the image push precedes the webhook, and confirm Portainer recreates RepoLens from the new image.

- [ ] **Step 4: Verify production**

Confirm container health, the `repolens-data` mount, `https://repolens.betalabs.org/api/health` HTTP 200, protected API HTTP 401 without a token, and HTTP 200 with the production token.
