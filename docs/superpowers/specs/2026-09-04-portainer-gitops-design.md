# Portainer GitOps Deployment Design

## Goal

Deploy every commit merged to `main` to the existing RepoLens production service without exposing Portainer or moving production secrets into Git.

## Flow

1. A push to `main` runs GitHub Actions.
2. The workflow builds the repository Dockerfile and publishes `ghcr.io/rezart/repolens:main` plus an immutable commit tag.
3. After the image is available, the workflow posts to a secret Portainer stack webhook.
4. Cloudflare routes only that exact webhook path to Portainer on `external-docker:9443`.
5. Portainer pulls the new image and recreates the RepoLens container.

The first workflow run skips deployment while `PORTAINER_WEBHOOK_ENABLED` is unset. This bootstraps the image before the current standalone container is migrated into Portainer.

## Production State

- The container listens on `192.168.7.195:3010`; `repolens.betalabs.org` continues routing there.
- `/opt/repolens/.env` remains the source of production secrets and is mounted read-only at `/app/.env`.
- The existing external `repolens-data` volume remains mounted at `/data`.
- Portainer uses the repository's production Compose file and tracks `main`.
- After the first publish, the GHCR package is explicitly made public because new packages default to private. The source repository is public and the image contains no runtime secrets.

## Security and Failure Behavior

- The Portainer dashboard remains private. Cloudflare publishes only the generated `/api/stacks/webhooks/<id>` path.
- The webhook URL is stored as the encrypted GitHub Actions secret `PORTAINER_WEBHOOK_URL`.
- The repository variable `PORTAINER_WEBHOOK_ENABLED=true` enables deployment after the stack and route exist.
- GitHub's job token receives only `contents: read` and `packages: write`.
- A failed image build never calls Portainer, leaving the current container running.
- The deployment request retries transient failures and fails the workflow if Portainer rejects it.
- Both push and manual runs refuse to publish or deploy any ref other than `refs/heads/main`.
- Immutable commit tags remain available for manual rollback.

## Verification

- Validate the production Compose file with `docker compose config`.
- Run the full test suite and TypeScript typecheck.
- Confirm the workflow publishes an image on the merge commit.
- Confirm Portainer reports the Git-backed stack running the GHCR image.
- Confirm public health returns HTTP 200, protected routes return 401 without a token and 200 with the production token, and the data volume is unchanged.
