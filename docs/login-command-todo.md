# `login` command — handoff (SHIPPED)

**Status:** SHIPPED (2026-05-28). Implemented as MCP tools in `@extension.dev/mcp`
plus an `extension-mcp login|logout|whoami` bin and two platform endpoints. The
sections below the "What shipped" block are the original design notes, kept for
context; where they say "today" / "open question", read them as the pre-build
state.
**Owner package:** `@extension.dev/mcp` (`extension-dev/packages/public-extensiondev-mcp`).
**Related tasks:** publish inversion was a stated prerequisite — it had **already
landed** before this work (MCP publish is self-contained; the OSS CLI is a thin
wrapper). The docs purge had also already happened.

---

## What shipped

Decisions made (the doc's open questions, resolved):

- **Model A**, MCP-owned. `login` is MCP tools (`extension_login`/`whoami`/
  `logout`) plus a human `extension-mcp login` bin. Not added to the OSS CLI.
- **Auth flow: GitHub device-code.** No local callback server; works headless.
  The interactive counterpart to `/api/oidc/exchange` (CI). Chosen over the
  localhost-callback flow because the MCP is agent-driven with no guaranteed
  browser/loopback.
- **Project resolution: explicit** `project: "<workspace>/<project>"` argument.
  The exchange verifies the caller is a member of that project's workspace.
- **TTL: 7 days** (the minter's hard `MAX_TTL_SECONDS` ceiling) + re-login.
  `whoami` surfaces expiry. (Also made the dashboard mint route honest: it
  advertised 30/365 days but the minter always clamped to 7.)

What was built:

- Platform (`apps/www.extension.dev`):
  - `services/registry/github-user.ts` — verify a GitHub user token via `GET /user`.
  - `app/api/cli/login/config/route.ts` — public GitHub client id + scope.
  - `app/api/cli/login/exchange/route.ts` — GitHub user token → project-scoped
    token (membership-checked, recorded for revocation). Modeled on `oidc/exchange`.
  - `app/api/projects/[projectId]/access-tokens/route.ts` — TTL honesty fix (7-day cap).
- MCP (`packages/public-extensiondev-mcp`):
  - `lib/credentials.ts` — versioned `0600` creds file, XDG/Windows aware.
  - `lib/github-device.ts` — device-code client (start + bounded poll).
  - `lib/login-flow.ts` — shared config-fetch + exchange + persist.
  - `tools/login.ts` (two-phase), `tools/whoami.ts`, `tools/logout.ts`.
  - `tools/publish.ts` — `resolveToken()` now env **>** creds file.
  - `index.ts` registers the tools and exposes `runCli`; `bin/extension-mcp.js`
    handles `login|logout|whoami` (blocking) and otherwise starts the server.
- Tests: credentials, token precedence, device client, GitHub user verifier.

Remaining (ops, not code):

- **Enable device flow** on the GitHub OAuth App behind
  `WWW_GITHUB_OAUTH_CLIENT_ID`. Until then `extension_login` cannot complete and
  users fall back to a dashboard-minted `EXTENSION_DEV_TOKEN`.
- **Cross-repo docs** (`extension.js` `_FUTURE/.../docs/ai/mcp.mdx` and
  `publish.mdx`) can now describe `extension_login` accurately. Not touched here
  (different repo).

---

## TL;DR

`extension publish` (and the MCP `extension_publish` tool) are auth-gated: they need an
`EXTENSION_DEV_TOKEN` — an HMAC **workspace/project access token** — sent as a `Bearer`
header to the extension.dev platform. **Today the user must mint that token by hand in the
dashboard and export it into their environment.** There is no command that automates
"authenticate me and put a usable token where the tooling can find it."

`login` is that missing command. Its job: take a developer from "logged into extension.dev
in a browser (GitHub OAuth)" to "a scoped token persisted locally that the publish path can
read" — without copy-pasting tokens.

It does **not** exist yet anywhere, and every doc reference to `extension login` is currently
**phantom** (documents a flow that was designed but never built). Those references are being
purged from the OSS docs in a parallel task; this doc is the record of what should eventually
replace them.

---

## Current state (grounded facts — verify before trusting)

### Auth model today
- The only credential is **`EXTENSION_DEV_TOKEN`**, read from the process environment.
- The OSS CLI `publish` builds the request in
  `extension-land/extension.js/programs/extension/commands/publish.ts`:
  - default API base `https://www.extension.dev` (override: `EXTENSION_DEV_API_URL`)
  - `POST {base}/api/cli/publish`
  - header `authorization: Bearer <EXTENSION_DEV_TOKEN>` (or `--token`)
  - body `{ ttlHours?, buildSha? }`
  - on missing token it tells the user to "create one in the extension.dev dashboard, or via
    the project access-tokens API."
- The MCP `extension_publish` tool (`src/tools/publish.ts`) currently **shells out** to that
  CLI via `runExtensionCli` (`src/lib/exec.ts`), inheriting `process.env` so the token flows
  through without the MCP ever logging or storing it. The tool's own description states it is
  *"the only tool that talks to the hosted platform rather than the local browser."*
- **MCP is auth-AWARE, not auth-HOLDING** by design: it never persists the token; it relies on
  the token already being in the environment / readable by the CLI.

### Platform side (where the token comes from / is verified)
- App: `extension-land/extension-dev/apps/www.extension.dev`.
- Browser auth already exists: **NextAuth** at `/api/auth/[...nextauth]`, **GitHub OAuth**
  (`src/auth.ts` persists `account.access_token`; the GitHub token honors `repo` scope).
- Token mint/verify: `mintAccessToken` / `verifyAccessToken` in
  `src/services/registry/access-tokens.ts` (imported as `@/services/registry/access-tokens`;
  `@/*` → `src/*`). The token is an **HMAC** token whose claims identify
  `{ workspaceSlug (u), projectSlug (p) }`.
- Dashboard-side minting endpoint: `POST /api/projects/[projectId]/access-tokens`
  (session-cookie gated, no CORS) and the workspace UI at `/api/workspace/api-tokens`
  (CSRF-protected, rate-limited, scopes like `builds:read|write`, `releases:write`).
- The CLI unblocker route: `POST /api/cli/publish` (`src/app/api/cli/publish/route.ts`) —
  authenticates with the `Bearer` access token (no browser session), returns
  `{ shareUrl, visibility, token?, expiresAt?, ttlHours? }`.

### The phantom references (to be removed, listed here for traceability)
- `extension.js.org/docs/commands/publish.mdx` → "run `extension login` then `extension publish`"
- `extension.js.org/docs/ai/mcp.mdx` → "Hosting prompts you to run `extension login`, which
  stores a token the CLI reads"
- A removed design doc (`docs/distribution/MCP-PUBLISH.md`, deleted) previously specced:
  `extension login` writes `~/.config/extension-dev/auth.json` (0600); CLI host phase reads it;
  MCP stays auth-aware. **This is the closest thing to a prior design — treat it as a starting
  proposal, not a committed spec.**

---

## The gap `login` closes

```
Today:   [user] --(manual: open dashboard, mint token, copy)--> EXTENSION_DEV_TOKEN env --> publish
Target:  [user] --(extension login: browser/device auth)--> local creds file --> publish (auto-discovers token)
```

---

## Scoping decision (important — resolve the tension)

The product rule agreed for this work: **platform-facing features (hosting, auth, tokens) are
scoped to extension.dev / `@extension.dev/mcp`, not the OSS extension.js core.** So `login` is
owned here, in the MCP/platform side — NOT added to the OSS CLI as a first-class feature.

**But there is a real tension to resolve before coding:** the publish auth model is "the CLI
reads the token from the environment / a local file; the MCP never holds it." If `login` lives
in the MCP, the token it acquires still has to reach whatever performs the publish POST. Two
models — pick one and document why:

- **Model A — MCP-owned login tool (`extension_login`).** The MCP runs the auth flow
  (device-code / OAuth against extension.dev), writes the token to a shared local credentials
  file, and the publish path (both the thin CLI wrapper and the MCP's own publish logic) reads
  that file. Honors "login scoped to MCP." Requires defining the shared creds-file contract so
  the OSS CLI can read a file it didn't write.
- **Model B — keep login out of both, document the manual token path only.** No login command;
  publish stays `EXTENSION_DEV_TOKEN`-only; docs simply explain how to mint a token in the
  dashboard. Lowest effort, no new surface. Valid if `login` is judged not worth building yet.

The prior (removed) design assumed an **OSS CLI `extension login`** writing
`~/.config/extension-dev/auth.json` — that contradicts the current scoping rule, which is why
it must be re-decided rather than copied.

---

## What a real `login` must do (functional requirements)

1. **Authenticate the developer** against extension.dev. Reuse the existing NextAuth/GitHub
   OAuth. For a CLI/MCP (no browser callback server assumed), prefer an **OAuth device-code
   flow** or a "open browser → paste short code / auto-callback to localhost" flow.
2. **Obtain a scoped access token** — the same HMAC workspace/project token `verifyAccessToken`
   accepts (claims `{workspaceSlug, projectSlug}`). Likely a new platform endpoint that mints a
   CLI token from an authenticated *session* (today minting is session/dashboard-gated; a
   device-flow needs a session→token exchange that doesn't require the dashboard UI).
3. **Persist it locally**, readable by the publish path (see storage contract below).
4. **Token discovery + precedence** for publish: `--token` flag > `EXTENSION_DEV_TOKEN` env >
   local creds file. (Today only the first two exist; adding the file is the new part.)
5. **`logout`** — delete the local creds file / revoke server-side if supported.
6. **`whoami` / status** — show the authenticated workspace/project + token expiry without
   printing the secret.
7. **Never log the token.** Mirror the existing publish.ts discipline (token flows through env,
   is never echoed).

---

## Proposed token storage contract (decide + lock)

- **Location:** `~/.config/extension-dev/auth.json` (XDG; respect `$XDG_CONFIG_HOME`).
  On Windows use the platform config dir.
- **Perms:** `0600`.
- **Shape (proposal — finalize):**
  ```jsonc
  {
    "version": 1,
    "token": "<hmac access token>",
    "workspaceSlug": "…",
    "projectSlug": "…",
    "expiresAt": "<iso8601>",     // if the minted token carries TTL
    "api": "https://www.extension.dev"
  }
  ```
- If this file is the cross-process seam, the OSS CLI publish wrapper must learn to read it
  (it currently reads env only). That edit lives in extension.js, so the **file format is a
  cross-repo contract** — version it.

---

## Relationship to publish (and the inversion task)

- A sibling task inverts publish ownership: **CLI `publish` becomes a thin wrapper; the owned
  publish logic moves into this MCP package** (`src/tools/publish.ts` becomes a self-contained
  HTTP POST instead of shelling out).
- Consequence for `login`: once publish logic lives in the MCP, the MCP must itself resolve the
  token (env → creds file). So **whoever implements the publish inversion should define the
  token-resolution helper that `login` then populates.** Build them together or land the
  token-resolution helper first.

---

## Open questions / decisions needed

1. **Model A or B** (above). If A, confirm `login` is an MCP tool (`extension_login`) and/or an
   `extension-mcp` bin subcommand — not an OSS `extension login`.
2. **Device-flow endpoint:** does the platform need a new `POST /api/cli/login` (device-code
   start + poll) and a session→CLI-token exchange? Today minting requires a dashboard session.
3. **Token scope:** per-project (claims need `projectSlug`) vs per-workspace. Publish needs the
   project; how does `login` choose/resolve the project for a given local repo?
4. **Token TTL / refresh:** are CLI tokens long-lived (manual rotate) or refreshable? `whoami`
   needs `expiresAt`.
5. **Creds-file ownership:** if the OSS CLI must read a file the MCP wrote, who owns the format
   and versioning? (Cross-repo contract — see storage section.)
6. **Multi-account / multi-workspace:** single token file vs profiles.

---

## Acceptance criteria (definition of done)

- [ ] A documented login flow exists (Model A or B explicitly chosen, with rationale).
- [ ] If Model A: `extension_login` (and/or `extension-mcp login`) authenticates and writes the
      creds file with `0600` perms; `logout` removes it; `whoami` reports identity + expiry
      without revealing the secret.
- [ ] Publish (CLI wrapper + MCP logic) resolves the token via `--token` > env > creds file.
- [ ] The token obtained verifies against `verifyAccessToken` and succeeds against
      `POST /api/cli/publish` end-to-end (returns a `shareUrl`).
- [ ] No token value is ever logged.
- [ ] The creds-file format is versioned and documented as a cross-repo contract.
- [ ] Docs updated: re-introduce accurate `login` references ONLY after it ships (until then
      they stay removed). Update `extension.js.org/docs/ai/mcp.mdx`.
- [ ] Tests: auth flow (mockable), token persistence/perms, precedence resolution, logout.

---

## Key files & references

**This package (`@extension.dev/mcp`)**
- `src/tools/publish.ts` — the only platform-gated tool; where token resolution must land.
- `src/lib/exec.ts` — `runExtensionCli` (inherits `process.env`).
- `claude/commands/extension-publish.md` — note: today this slash command is about **store
  submission** (Chrome Web Store / AMO), NOT extension.dev hosting — don't conflate.

**OSS CLI (`extension-land/extension.js`)**
- `programs/extension/commands/publish.ts` — the request builder; `EXTENSION_DEV_TOKEN`,
  `DEFAULT_API`, `/api/cli/publish`. The thin wrapper after inversion.

**Platform (`extension-land/extension-dev/apps/www.extension.dev`)**
- `src/app/api/cli/publish/route.ts` — Bearer-token publish route; claims `{workspaceSlug,
  projectSlug}`; returns `{shareUrl, visibility, token?, expiresAt?, ttlHours?}`.
- `src/services/registry/access-tokens.ts` — `mintAccessToken` / `verifyAccessToken` (HMAC).
- `src/app/api/projects/[projectId]/access-tokens` — dashboard mint endpoint (session-gated).
- `src/app/api/workspace/api-tokens/route.ts` — workspace token UI endpoint (CSRF, scopes).
- `src/auth.ts`, `src/app/api/auth/[...nextauth]` — existing GitHub OAuth to reuse.

---

## Out of scope / non-goals
- Store submission credentials (Chrome/AMO/Edge) — that's `deploy`, separate.
- Adding `login` to the OSS extension.js core as a first-class feature (violates the scoping
  rule unless Model A's creds-file seam is explicitly agreed).
- Re-introducing the phantom doc references before the command actually ships.
