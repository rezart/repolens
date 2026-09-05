# Running Revision Tooltip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the exact commit SHA baked into the running image as a native tooltip on the existing dashboard version number.

**Architecture:** GitHub Actions passes the main-branch SHA into the Docker build, and the image stores it as `REPOLENS_REVISION`. Existing configuration and `/api/health` carry the optional value to the dashboard, which assigns it to the version element's `title` attribute.

**Tech Stack:** TypeScript, Hono, vanilla JavaScript, Docker, GitHub Actions, Vitest/JSDOM.

---

### Task 1: Carry the image revision to the version tooltip

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `Dockerfile`
- Modify: `src/config.ts`
- Modify: `src/app.ts`
- Modify: `web/app.js`
- Test: `tests/config.test.ts`
- Test: `tests/server.test.ts`
- Test: `tests/web/markdown.test.ts`

- [ ] **Step 1: Write failing configuration and health tests**

Add assertions that an absent revision becomes `null`, whitespace is trimmed, and `/api/health` exposes the configured value:

```ts
expect(loadConfig({ LLM_PROVIDER: 'claude-cli' }).revision).toBeNull();
expect(loadConfig({ LLM_PROVIDER: 'claude-cli', REPOLENS_REVISION: ' abc123 ' }).revision).toBe('abc123');
```

In `tests/server.test.ts`, construct the test app with `REPOLENS_REVISION: 'abc123'` and assert:

```ts
expect((await res.json()).revision).toBe('abc123');
```

- [ ] **Step 2: Write the failing dashboard tooltip test**

Expose a test-only closure from the existing JSDOM evaluation string, then render health into real `#health` and `#version` nodes:

```js
window.renderHealthForTest = (health) => {
  state.health = health;
  dom.health = document.getElementById('health');
  dom.version = document.getElementById('version');
  renderHealth();
};
```

Assert the visible label and native tooltip independently:

```ts
dom.window.document.body.innerHTML = '<div id="health"></div><span id="version"></span>';
dom.window.renderHealthForTest({ ok: true, version: '0.1.0', revision: 'abc123', llm: {}, chat: {} });
expect(dom.window.document.getElementById('version')?.textContent).toBe('v0.1.0');
expect(dom.window.document.getElementById('version')?.getAttribute('title')).toBe('abc123');
```

- [ ] **Step 3: Run the focused tests and verify the expected failures**

Run:

```bash
npx vitest run tests/config.test.ts tests/server.test.ts tests/web/markdown.test.ts
```

Expected: failures because `Config.revision`, health `revision`, and the tooltip assignment do not exist.

- [ ] **Step 4: Implement the optional revision data path**

In `src/config.ts`, add a trimmed optional environment field, a nullable `Config.revision`, and the returned value:

```ts
REPOLENS_REVISION: z.string().trim().default(''),
// Config
revision: string | null;
// loadConfig return
revision: e.REPOLENS_REVISION || null,
```

In `src/app.ts`, include the value in health output:

```ts
revision: config.revision,
```

In `web/app.js`, preserve the visible version and manage the native tooltip:

```js
dom.version.textContent = hp.version ? 'v' + hp.version : '';
if (hp.revision) dom.version.title = hp.revision;
else dom.version.removeAttribute('title');
```

- [ ] **Step 5: Bake the GitHub SHA into production images**

In `Dockerfile`, add:

```dockerfile
ARG REPOLENS_REVISION
ENV REPOLENS_REVISION=${REPOLENS_REVISION}
```

In `.github/workflows/deploy.yml`, add to the existing `docker/build-push-action` inputs:

```yaml
build-args: |
  REPOLENS_REVISION=${{ github.sha }}
```

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
npx vitest run tests/config.test.ts tests/server.test.ts tests/web/markdown.test.ts
npm test
npm run typecheck
node --check web/app.js
git diff --check
```

Expected: all tests and checks pass.

- [ ] **Step 7: Commit the implementation**

```bash
git add .github/workflows/deploy.yml Dockerfile src/config.ts src/app.ts web/app.js tests/config.test.ts tests/server.test.ts tests/web/markdown.test.ts docs/superpowers/plans/2026-09-05-version-revision-tooltip.md
git commit -m "feat(ui): show running revision on version hover"
```

- [ ] **Step 8: Open a pull request and validate deployment after merge**

Push `feat/version-revision-tooltip`, open a PR against `main`, and require a successful `repolens/review` on its latest head. After the manager merges it, verify the Deploy workflow, exact OCI revision, `/api/health.revision`, and the public version tooltip all match the merge SHA.
