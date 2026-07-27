# Changelog

## Unreleased

Every tool now returns the same frame. Before this, 28 tools hand-built 142
different JSON shapes: `ok` appeared on 71 of them, `error` on 67, `hint` on 60,
`message` on 49, `status` on 46, and five more keys carried the same meaning
under different names. An agent could not tell success from failure without
knowing which tool it had called.

The frame is schema 1, the same one the Extension.js CLI emits under
`--output json`:

```json
{
  "schema": 1,
  "ok": false,
  "command": "extension_dev",
  "status": "compile-failed",
  "value": null,
  "error": { "code": "E_FIRST_COMPILE", "message": "…" },
  "hint": "…",
  "warnings": []
}
```

`command` names the tool. `status` is a kebab-case word from that tool's own
vocabulary. `error.code` is stable and worth branching on; `error.message` is
free copy and is not. The payload moved under `value`, and every advisory note
that used to have its own key is now an entry in `warnings`.

**Breaking.** Every payload key moved one level down. `build.success` is now
`ok`, `doctor.healthy` is now `ok`, `manifest_validate.valid` is now
`value.valid`, and `wait` gained the `ok` it never had. The ready contract's own
`command` is carried as `value.sessionCommand`, because the envelope claims that
key. `authorization_pending` became `authorization-pending`, with the old
spelling echoed as `value.legacyStatus` for one minor.

`extension_dev` and `extension_start` also stopped reading the dev server's
prose to decide whether the first compile failed. They poll its `ready.json`
contract instead, which splits a locked profile out of a dead browser and
returns the compile errors as a list. The output scrape survives only as a
fallback for a project whose own CLI predates the contract, is confined to one
`@deprecated` module, and says so in `warnings` whenever it is used. The choice
is a capability probe, never a version check: a project-local `extension` binary
wins over this package's pin, so the version is not knowable in advance.

## 9.0.0

Every client pays for this server's tool list at the start of every session,
whether or not the user ever touches an extension. That list was 36 tools and
52,403 bytes on the wire (roughly 13,100 tokens). It is now 28 tools and
43,214 bytes (roughly 10,800 tokens), a 17.5% cut, with no capability removed.
Eleven tools folded into the four that already owned their resource,
`extension_preview` folded into `extension_start`, and the prose was tightened
everywhere it repeated the schema or a parameter name.

9.0.0 lands close behind 8.0.0 on purpose. 8.0.0 renamed four tools for
disambiguation; this release cuts what the surface costs. Both are breaking,
adoption is still low, and doing them as one migration is cheaper for early
users than spacing them out.

### Migration

| Old tool | New call |
| --- | --- |
| `extension_detect_browsers({ browsers })` | `extension_browsers({ action: "detect", browsers })` |
| `extension_list_browsers()` | `extension_browsers({ action: "list" })` |
| `extension_install_browser({ browser })` | `extension_browsers({ action: "install", browser })` |
| `extension_uninstall_browser({ browser, all })` | `extension_browsers({ action: "uninstall", browser, all })` |
| `extension_login({ project, deviceCode, api })` | `extension_auth({ action: "login", project, deviceCode, api })` |
| `extension_whoami()` | `extension_auth({ action: "status" })` |
| `extension_logout()` | `extension_auth({ action: "logout" })` |
| `extension_list_templates({ surface, framework, tags, featured, query })` | `extension_templates({ action: "list", surface, framework, tags, featured, query })` |
| `extension_get_template_source({ slug, files })` | `extension_templates({ action: "source", slug, files })` |
| `extension_release_list({ workspace, project, api })` | `extension_release_status({ include: ["releases"], workspace, project, api })` |
| `extension_store_status({ workspace, project, api })` | `extension_release_status({ include: ["stores"], workspace, project, api })` |
| `extension_preview({ projectPath, browser, port, noBrowser, ...launch })` | `extension_start({ projectPath, build: false, browser, port, noBrowser, ...launch })` |

Every argument keeps its name and its meaning. `action` defaults to the most
common case (`detect`, `status`, `list`), so `extension_browsers({})` scans,
`extension_auth({})` reports the login, and `extension_templates({})` lists.
`extension_release_status` returns both sections by default and nests each
under `releases` and `stores`; the old flat bodies are unchanged inside them.
The CLI is untouched: `extension-mcp login|logout|whoami|release` still work
exactly as before.

`extension_submit`, `extension_publish`, `extension_analyze`,
`extension_inspect` and `extension_dom_snapshot` were deliberately NOT merged.
8.0.0 separated them because agents confused them; folding them behind an
`action` parameter would hide that ambiguity rather than remove it.

### Upgrading from 7.0.0

Most installs are still on 7.0.0 and two majors have landed on top of it. Do
both in one pass: apply the 8.0.0 renames, then the 9.0.0 merges above. 7.0.0
advertised 36 tools; 9.0.0 advertises 28, and every capability survived.

| 7.0.0 call | 9.0.0 call | Landed in |
| --- | --- | --- |
| `extension_deploy(...)` | `extension_submit(...)` | 8.0.0 |
| `extension_inspect({ projectPath })` | `extension_analyze({ projectPath })` | 8.0.0 |
| `extension_source_inspect(...)` | `extension_inspect(...)` | 8.0.0 |
| `extension_dom_inspect(...)` | `extension_dom_snapshot(...)` | 8.0.0 |
| `extension_detect_browsers({ browsers })` | `extension_browsers({ action: "detect", browsers })` | 9.0.0 |
| `extension_list_browsers()` | `extension_browsers({ action: "list" })` | 9.0.0 |
| `extension_install_browser({ browser })` | `extension_browsers({ action: "install", browser })` | 9.0.0 |
| `extension_uninstall_browser({ browser, all })` | `extension_browsers({ action: "uninstall", browser, all })` | 9.0.0 |
| `extension_login({ project, deviceCode, api })` | `extension_auth({ action: "login", project, deviceCode, api })` | 9.0.0 |
| `extension_whoami()` | `extension_auth({ action: "status" })` | 9.0.0 |
| `extension_logout()` | `extension_auth({ action: "logout" })` | 9.0.0 |
| `extension_list_templates({ surface, framework, tags, featured, query })` | `extension_templates({ action: "list", surface, framework, tags, featured, query })` | 9.0.0 |
| `extension_get_template_source({ slug, files })` | `extension_templates({ action: "source", slug, files })` | 9.0.0 |
| `extension_release_list({ workspace, project, api })` | `extension_release_status({ include: ["releases"], workspace, project, api })` | 9.0.0 |
| `extension_store_status({ workspace, project, api })` | `extension_release_status({ include: ["stores"], workspace, project, api })` | 9.0.0 |
| `extension_preview({ projectPath, browser, port, noBrowser, ...launch })` | `extension_start({ projectPath, build: false, browser, port, noBrowser, ...launch })` | 9.0.0 |

Read the `extension_inspect` row before any of the others. That name exists in
both versions and does not mean the same thing in each. In 7.0.0 it read a
BUILT extension's files off disk. In 9.0.0 it reads a RUNNING extension over
the browser's debugger protocol and needs a live `extension_dev` or
`extension_start` session. A 7.0.0 call left alone does not fail with an
unknown-tool error, it silently reaches the wrong tool and reports no dev
session instead of the file sizes you asked for. The disk reader is
`extension_analyze` now. Every call that passed a bare `projectPath` and
expected sizes, permissions and store-readiness back has to move.

`extension_deploy` carried its error names with it into `extension_submit`:
`DeployAuthError`, `DeployInputError`, `DeployConfigError`,
`DeployNetworkError` and `DeployError` are now `SubmitAuthError`,
`SubmitInputError`, `SubmitConfigError`, `SubmitNetworkError` and
`SubmitError`. Anything branching on those strings has to move with them.

Every argument keeps its name and its meaning across both majors, with two
exceptions:

- `extension_release_status` nests what the two 7.0.0 tools returned flat,
  under `releases` and `stores`. The bodies inside are byte-for-byte the old
  ones. Omitting `include` returns both sections.
- `extension_start` gained `build`, defaulting to `true`. `build: false` is
  what `extension_preview` was.

Nothing else moved. `extension_publish`, `extension_preview_web`,
`extension_shares`, `extension_release_promote`, `extension_dev`,
`extension_build`, `extension_create`, `extension_add_feature`,
`extension_wait`, `extension_stop`, `extension_logs`, `extension_eval`,
`extension_storage`, `extension_reload`, `extension_open`,
`extension_list_extensions`, `extension_manifest_validate`,
`extension_theme_verify` and `extension_doctor` are unchanged in name and in
arguments, and the CLI (`extension-mcp login|logout|whoami|release`) never
moved at all.

### Merged

- **Four browser tools are one.** `extension_browsers` detects, lists,
  installs, and uninstalls. `detect` and `list` were the confusable pair: both
  answered "what browsers do I have", and telling them apart took a sentence of
  prose in each description. An action enum settles it in the schema.
- **Three auth tools are one.** `extension_auth` signs in, reports the stored
  login, and clears it. They were a lifecycle triad that each re-explained the
  same token model.
- **Two template tools are one.** `extension_templates` searches the catalog
  and reads a template's source. The slug you read comes from the list you just
  searched, so the pair is one resource.
- **The two read-only release tools are one.** `extension_release_status`
  returns release channels and recent builds, browser-store submissions and
  review state, or both. They took identical arguments and read the same
  registry. `extension_release_promote` stays separate on purpose: it is the
  only verb that writes, and putting a write behind the same `action`
  parameter as a read is how an agent promotes a build it meant to list.
- **`extension_preview` folded into `extension_start`.** Both answered "run the
  production build in a browser"; the only difference was whether a build ran
  first. That is now `build`, defaulting to `true`, which matches
  `extension_preview_web`, where `build: false` already means the same thing.

### Sharpened

- **`extension_dev` and `extension_start` now say which one to pick.**
  They are not merged: `dev` is the only tool that can unlock the control
  channel (`allowControl`, `allowEval`) that `extension_storage`,
  `extension_reload`, `extension_open`, `extension_dom_snapshot` and
  `extension_eval` need, and `start` runs a production build with none of it.
  A `mode` parameter would have made those flags look valid on a session that
  cannot honor them. Instead each description now opens with the thing that
  decides between them and names the other tool.
- **Descriptions no longer repeat the schema.** The biggest cuts, in bytes of
  description: `extension_shares` 1,661 to 1,250, `extension_preview_web`
  1,151 to 639, `extension_submit` 1,478 to 1,194, `extension_eval` 1,128 to
  831, `extension_wait` 985 to 784, `extension_list_extensions` 944 to 696,
  `extension_dom_snapshot` 965 to 854. What was cut was prose that restated a
  parameter name, repeated a property's own description, or explained the
  response shape the response already carries. What was kept is anything that
  stops a tool being misused: the `activeTab` gesture warning on
  `extension_open`, the MV3 service-worker CSP note on `extension_eval`, the
  profile-lock explanation on `extension_dev`, and the irreversibility of
  `extension_submit` and of revoking a share.
- **Repeated property schemas are shared.** `projectPath`, the session
  `browser`, the call `timeout`, the platform `api` base and the launch browser
  enum are defined once in `src/lib/common-schema.ts` instead of being
  re-typed per tool.

### Considered and rejected

- **A smaller default surface with the rest opt-in.** The platform cluster
  (`extension_auth`, `extension_publish`, `extension_submit`,
  `extension_release_status`, `extension_release_promote`, `extension_shares`,
  `extension_preview_web`) is 13 KB, about 30% of what is left, and is dead
  weight for anyone building an extension locally without an extension.dev
  account. Hiding it behind an env flag would cut the default surface by
  roughly a third. It was not shipped because a hidden tool is an invisible
  capability: an agent asked to publish would report that it cannot, which is
  worse than the tokens. The version worth building expands the surface once a
  login exists and announces it with `notifications/tools/list_changed`, and
  that needs a client-by-client compatibility check first.

### Added

- `pnpm exec node scripts/tool-surface-size.mjs` starts the server, calls
  `tools/list`, and reports exactly what a client receives: bytes per tool
  split into description and schema, and the total. `--json` for the raw rows.
  Before this, the cost of the tool surface was never measured, only guessed.

## 8.0.0

Four tools are renamed. Every rename fixes a name that made agents pick the
wrong tool, and one of them could cost you a store submission you did not ask
for. No behavior changes, no argument changes.

### Migration

| Old name | New name |
| --- | --- |
| `extension_deploy` | `extension_submit` |
| `extension_inspect` | `extension_analyze` |
| `extension_source_inspect` | `extension_inspect` |
| `extension_dom_inspect` | `extension_dom_snapshot` |

`extension_publish` is unchanged.

### Renamed

- **`extension_deploy` is now `extension_submit`.** The pair was inverted
  against every other developer tool: `extension_publish` pushes a build to the
  extension.dev platform, while `extension_deploy` submitted to the Chrome Web
  Store, Firefox AMO, Edge Add-ons and the App Store. An agent told to "deploy
  my extension" reached for the store tool, and picking wrong there means an
  unintended store submission, which is irreversible. "Submit" is the stores'
  own word for it ("submit for review"), so the name now says what happens.
  `extension_publish` keeps its name and its job. The error names in the
  response follow: `DeployAuthError`, `DeployInputError`, `DeployConfigError`,
  `DeployNetworkError` and `DeployError` are now `SubmitAuthError`,
  `SubmitInputError`, `SubmitConfigError`, `SubmitNetworkError` and
  `SubmitError`.
- **Three tools were called inspect; now one is.** `extension_inspect` read a
  built extension's files off disk, `extension_source_inspect` read a running
  extension's live state, and `extension_dom_inspect` snapshotted one surface's
  DOM. The name that reads as the primary one belonged to the static file
  reader, which is the least of the three. Static analysis is now
  `extension_analyze`, and the live-state tool takes `extension_inspect`.
- **`extension_dom_inspect` is now `extension_dom_snapshot`.** It is not a
  duplicate of the live-state tool and it survives the rename with its
  capabilities intact, but sharing the word "inspect" was most of why the two
  were confusable. The descriptions now state the split outright:
  `extension_dom_snapshot` is the surface picker (it is the only tool that
  reads an OPEN extension surface by name, the only one that takes a numeric
  `chrome.tabs` id, and the only one that enumerates what is open) and it
  returns a shallow snapshot over the CDP-free agent bridge, which needs
  `allowControl: true`. `extension_inspect` is the deep reader (it is the only
  tool that pierces CLOSED shadow roots, runs CSS selector probes, and
  navigates a tab before reading it) and it rides the debugger protocol.

## 7.0.0

`preview.extension.dev` is the only web door this package knows about. The
inspect door predates it and had stopped being reachable.

### Removed

- **`extension_preview_web` no longer takes `surface` or `inspectUrl`.**
  `surface:"inspect"` pointed a local build at `inspect.extension.dev` over the
  `inspect://path` scheme, which is what the tool did before
  `preview.extension.dev` existed. Only the inspect dev server ever answered it:
  the deployed origin serves store listings and has no `/__inspect/fetch`, so
  the door resolved on one machine and nowhere else. Every build now renders in
  `preview.extension.dev`, which is also the surface that carries the
  Emulated/Real lane toggle and the Trace tab. The response no longer carries a
  `surface` field, and `hostUrl` is the only origin override.
- **The carrier no longer allowlists `inspect.extension.dev`.** Pairing needs a
  page that opens the bridge, and inspect never did: it traces the emulated lane
  of the extension it fetched and has no lane toggle. `extension_dev`
  `carrier: true` and the pairing notes now point at `preview.extension.dev`,
  and the carrier's `externally_connectable` drops the origin that was never
  going to connect.
- **`extension_login` no longer falls back to the GitHub device flow.**
  extension.dev hosts the device flow itself and federates GitHub server-side, so
  the only authorization surface is `extension.dev/device` and no GitHub token
  ever lands on the caller's machine. The legacy path is gone entirely: the
  GitHub device-code client, the `provider` fork (which existed twice, once in the
  tool and once in the `extension-mcp login` bin), the
  `/api/cli/login/exchange` hop, and the `EXTENSION_DEV_GITHUB_CLIENT_ID`
  override. Stored credentials record `provider: "extensiondev"` and
  `extension_whoami` reports that instead of defaulting to `"github"`. Nothing
  changes for a caller who was already on the branded flow, which is every caller
  the platform has served since it went live; a self-hosted platform pinned to
  the old exchange endpoint is no longer supported.

## 6.6.0

A shared build belongs to the project that owns it, not to whoever happened to
press publish. `extension_shares` now says which of the two it is looking at,
and it names the publisher without ever inventing one.

### Added

- **Every listed share carries its owner and its publisher.** The platform now
  returns `owner` and `sharedBy` on each row and both come through untouched,
  alongside an `attribution` block that reads them. `attribution.ownership` is
  `"project"` when the owning workspace holds the share, `"personal"` when one
  person holds it alone, and `"unknown"` when the platform disclosed no owner.
  `attribution.ownerPath` gives the owning `workspace/project` for a project
  share. Ownership is read off `owner` and never off the publisher, because the
  owner is what decides who may revoke a share and the publisher is only who
  made it.
- **`attribution.revocableBy` says who can actually pull the link back.** A
  project share is revocable by any member of the owning workspace and by any
  token scoped to the owning project. A personal share belongs to one person,
  so nobody else can see it or revoke it and a project token cannot touch it.
  Knowing which of the two you are holding is the difference between a revoke
  that will work and a 404 that reads like a bug.
- **`server.ownership` counts the listed shares by owner.** Project, personal
  and unknown, so a list can be reasoned about without walking every row.

### Changed

- **A publisher is never guessed.** `attribution.credit` is the GitHub login
  when the platform resolved one. When a share was made by a CLI token whose
  issuer could not be resolved it reads `CLI token <id>`, which is exactly what
  the credential itself proves, and a share made before attribution existed
  reads as not recorded. The workspace slug, the project slug and the owner are
  never substituted for a name, because naming a team where a human is expected
  attributes the share to whoever the reader takes that team to be.
  `attribution.creditSource` says which of the three it was.
- **Attribution is stated as attribution.** The response spells out that
  `sharedBy` records who published a share and grants and restricts nothing, so
  it is not read as a permission.
- **A truncated list is more explicit about why.** `truncated` also goes true
  when the platform spends its budget working out which shares the caller is
  entitled to see, so the note now says `matched` is a floor rather than a
  total.
- **Revoking a share the token does not own explains the personal case.** The
  404 message already covered a different project and an already dead link; it
  now also names a teammate's personal share, which no project token can
  revoke.

## 6.5.0

A link you shared is no longer only as findable as the response that created
it. The shares you have made are now listable, and revocable, from the tool
that made them.

### Added

- **`extension_shares` lists and revokes the links you have shared.**
  `share:true` hands back a public link, an `expiresAt` and a `revokeUrl`, and
  until now the only copy of that `revokeUrl` was the tool response and the
  project's own `.extension.dev/shared-previews.json`. Neither could say what
  was actually still live, and neither existed at all for a link shared from
  another machine. `action:"list"` (the default) asks the platform for every
  artifact the logged-in project owns and returns each one's `artifactId`,
  name, version, live or dead state, `createdAt`, `expiresAt`, `revokedAt`,
  size, and its `previewUrl`, `zipUrl` and `revokeUrl`. `previewUrl` and
  `zipUrl` come back null for anything no longer live, because a revoked or
  expired address resolves for nobody and echoing it back would invite passing
  on a dead link; `revokeUrl` stays on every row.
- **`action:"revoke"` kills a link from where it was made.** It takes an
  `artifactId` or, just as well, any URL of the share (`previewUrl`, `zipUrl`,
  `viewUrl`, or `revokeUrl`), so the link you sent someone is enough to pull it
  back without going to find a `curl` command. Revocation is permanent: the zip
  is deleted and the id is burned, so a revoked link can never resolve again
  and sharing the same build later mints a different one. The response says so
  rather than reading like an undoable delete.
- **The platform's answer is reconciled with the project's record.** Pass
  `projectPath` and every listed share is matched against
  `.extension.dev/shared-previews.json`: a share the project recorded carries
  its local `sharedAt`, `browser` and `distDir`, a share the platform knows
  about but the project does not is flagged `remoteOnly` (shared from another
  machine or another checkout), and a local record with no artifact behind it
  is reported under `localOnly`. The tool only ever reads that file, never
  rewrites it, so its append-only history stays intact.
- **A cut list is never passed off as the whole set.** When the platform
  answers `truncated:true`, the response carries the count that came back
  against the count that matched, says to raise `limit` or narrow with
  `status:"live"`, and refuses to call a `localOnly` record dead, because a
  share missing from a truncated list has not been shown to be gone.

### Changed

- **A successful share now says where to find the link again.** The `share`
  note and the `extension_preview_web` tool description both point at
  `extension_shares`, at the moment the link exists and the question of how to
  reach it later is about to come up.

## 6.4.0

A build on your machine can now become a link someone else can open, and the
bundled Live Preview carrier finally allows the origin that opens it.

### Added

- **`extension_preview_web` renders an in-progress build in the web emulator.**
  It builds the project, points `preview.extension.dev` at `dist/<browser>` over
  the dev-only `preview://build` scheme, and returns a deep link plus a
  loadability check against the preview dev server. `surface:"inspect"` renders
  in `inspect.extension.dev` instead, for fixture and forensic work. This tool
  reaches npm for the first time in this release.
- **`share:true` uploads the build you just made.** It POSTs the resolved
  `dist/<browser>` to the platform's artifact store and returns a public
  `preview.extension.dev` link that renders those exact bytes, for a recipient
  with no install, no sign-in, and no dev server. That link also serves the
  whole build as a downloadable zip (`share.zipUrl`), so sharing it hands over
  the built code. `share.serves` reports `uploaded-local-build`. Sharing needs a
  token scoped to an existing extension.dev workspace and project
  (`extension_login` or `EXTENSION_DEV_TOKEN`, valid up to 7 days), degrades to
  a login hint when there is no token, and never fails the local preview.
  `share` also returns `expiresAt` and `revokeUrl`: shared builds expire, and
  `DELETE`ing `revokeUrl` with the same token kills the link for good, which is
  the part a TTL alone cannot do when a link reaches the wrong person.
- **A shared link's revoke handle survives losing the tool output.** Revocation
  is permanent and re-sharing mints a new artifact id, so `share.revokeUrl` is
  the only handle that can ever pull a given link, and losing it used to mean
  waiting out the 30-day TTL. Every successful share is now appended to
  `.extension.dev/shared-previews.json` in the project, next to the carrier's
  own project-local state and gitignored the same way: one entry per share with
  `previewUrl`, `artifactId`, `revokeUrl`, `expiresAt`, `zipUrl` and the time it
  was shared. The list is only ever appended to, an unreadable file is kept
  aside instead of overwritten, a write that fails never fails the share, and
  the returned `share.record` and note say where the handle went. If the entry
  cannot be added to `.gitignore`, the response says so.
- **`extension_theme_verify` settles a Chrome theme manifest before it ships.**
  It derives every color current Chrome would paint from the manifest with a
  transcribed Chromium resolver and reports the divergence class of any problem:
  D1 fabrication, D3 parity gap, D4 acceptance gap (keys Chrome silently
  discards, such as dead legacy keys, incognito keys, unknown keys and
  out-of-range values). The legs that need a real browser come back as
  `needsAttended` with a pointer to the attended harnesses, never as passed.

### Fixed

- **The bundled Live Preview carrier reaches `preview.extension.dev`.** This
  package ships the carrier prebuilt and `extension_dev` materializes it into
  the project's `./extensions`, so the carrier only changes when the package
  does. Its `externally_connectable` allowlist had no web preview origin, so a
  page on `preview.extension.dev` could not talk to the carrier at all. 6.3.0
  shipped without the fix.
- The carrier popup requested `icons/icon.png` while the carrier build ships
  `images/icon.png`, so the popup icon was broken.

### Changed

- `extension_preview_web` takes no `channel` argument. It renders the build on
  disk, not a promoted CI build. `extension_publish` and
  `extension_release_promote` are unchanged and remain the path for released,
  channel-scoped builds.
- The server advertises 35 tools, up from 33.

## 6.3.0

Private projects stop reading as empty, and the links this server hands back
stop being login-only.

### Fixed

- **Registry reads work for PRIVATE projects.** `extension_release_list`,
  `extension_store_status`, `extension_deploy` and `extension_publish` read the
  project's state from `registry.extension.land`, which answers 401 for a
  private project. That 401 was reported as "no registry data", so a project the
  operator owns and is logged into looked like it had no builds at all. A 401 or
  403 now mints a short-lived read token and retries once. Public projects are
  untouched: still one request, still no call to the platform.
- The stored login token is never used as the `?t=` URL parameter even though it
  would verify. It is long-lived, and a credential in a query string is kept by
  every proxy and access log on the path, so it is traded for a ten-minute token
  first. Requires the bearer path on `POST /api/access-grant`.

### Added

- **Public build links.** `extension_release_list` returns a `publicUrl` for
  every channel and build plus a `publicProjectUrl`, and
  `extension_release_promote` returns `publicChannelUrl` and `publicBuildUrl`.
  Every link these tools returned before pointed at the console, which requires
  a login and workspace membership, so it was a dead end for the teammate or
  reviewer the operator wanted to send it to. The public pages carry the
  per-browser downloads, the run-locally and integrity dialogs, and what's new.
  For a private project the response says plainly that an outside recipient
  still needs a share link from `extension_publish`.
- `api` is accepted by `extension_release_list` and `extension_store_status`,
  matching the other hosted-facing tools. It picks the platform the read token
  is minted against and the origin the returned links point at.

### Changed

- Depends on `@extension.dev/urls` `^0.3.0` for the new `userland` origin and
  its whole-URL builders, so a build link this server returns cannot drift from
  the routes the viewer serves.

## 6.2.0

The URL layer stops being a copy. This server used to carry byte-identical
vendored mirrors of the fleet's origin resolver and path builders, kept honest
by a drift guard; it now depends on the published package instead.

### Changed

- **Depends on `@extension.dev/urls` instead of vendoring it.** The mirrors at
  `lib/urls-origins.ts` and `lib/urls-paths.ts` are gone, and `registry.ts`,
  `login-flow.ts`, and `create.ts` import the package directly. It is bundled
  into `dist`, so the install footprint is unchanged: no new runtime
  dependency, same standalone server.
- **`preview.extension.dev` resolves like every other fleet origin.** `preview`
  is now a first-class origin in the shared resolver, so `EXTENSION_DEV_PREVIEW_URL`
  is honored and an unset preview host follows the same local-vs-prod signal as
  console, inspect, and registry rather than defaulting to production.

## 6.1.0

The create flow stops dead-ending at `run dev` and points you to the web to
host, template source resolves whichever path the catalog listed, and the
links the server hands back ride the exact corpus commit it built from.

### Added

- **`extension_create` signposts the web deploy.** The result now carries a
  `deployUrl` and a closing next step that says the scaffold runs locally and
  where to open the template on the web to host it, so the local scaffold no
  longer stops at `run dev` with nowhere to ship.
- **`extension_create` names the template it chose.** When no `template` is
  passed the response now discloses the silent default instead of quietly
  scaffolding TypeScript, and points at `extension_list_templates` to pick
  another.

### Fixed

- **`extension_get_template_source` resolves listed paths.** A file listed
  with a leading `public/<slug>/` or `examples/<slug>/` prefix now strips to
  the slug relative path both hosts actually serve, so passing back a listed
  path no longer 404s.
- **`extension_list_templates` keeps the vanilla template filterable.** The
  relabel no longer drops the framework key the filter reads.
- **`extension_add_feature` links ride the pinned corpus.** Feature links now
  point at the pinned corpus commit instead of floating on `main`.

## 6.0.0

The server moves to Apache-2.0, and the live-preview carrier stops living
in your project, reports what it refused, and rides an engine that tells
you when the browser turned your extension away.

### Changed

- **License: MIT is now Apache-2.0.** Everything published up to and
  including 5.6.1 was released under MIT and stays MIT forever; you keep
  those rights on those versions. From 6.0.0 forward the license is
  Apache-2.0, which adds an express patent grant and requires anyone
  shipping a modified copy to state that they changed the files. For almost
  every user this changes nothing about what you are allowed to do.

### Fixed

- The live-preview carrier is no longer a permanent resident of the
  project. `extension_stop` removes it, `extension_build` removes it
  before the build runs (and refuses to call a build clean if it ever
  finds the carrier in `dist/`), and `extension_dev carrier: true` adds
  it to `.gitignore` so the first `git add -A` cannot vendor it. Every
  path is marker-guarded: a directory the tool did not place is reported,
  never removed.
- `extension_open` no longer navigates away whatever page the caller was
  watching. It reuses only a disposable tab (blank, new-tab page, or a
  tab already on the same extension origin) and otherwise opens a new
  background tab, so a trace page keeps its carrier registration.
- `extension_open` treats a client-side redirect as a landing instead of
  reporting `NavigateFailed`, and reports where the page went. A failed
  `http(s)` navigation no longer sends the caller off to debug their own
  bundle.
- `extension_open` confirms with the browser that a UI surface actually
  opened. When the engine reports the surface opened and no document
  target appears, the result says so (`SurfaceDidNotOpen`) and points at
  `asTab: true`, instead of handing back a green answer for a surface
  that is not there.

- The bundled carrier payload answers with its real results. Every
  backend method returns the promise it was given instead of a shape,
  so a `chrome.*` call that rejects reaches the caller as a failure;
  `executeScript` refuses `func`/`code` forms it cannot honor, offscreen
  close is verified, and `downloads.erase` is implemented. A refusal now
  rides a `refused` disposition from the refusal site through the carrier
  into the trace, so refused calls stop being badged as real work and
  stop earning coverage. Storage rows correlate on a canonical key (one
  call, one row), tab facts survive both directions, and the event port
  replays its backlog to a page that connects late.

### Changed

- The engine this server spawns when a project has no local install is
  pinned to `4.0.16-canary.1784889479.74e12044`. Two behaviors are worth
  the prerelease: `EXTENSION_HEADLESS` is finally honored, so an agent
  driving `extension_dev` cannot open a window on the operator's screen,
  and a browser refusing to load the extension is reported as an error
  instead of a session that claims to be ready. `extension_wait` already
  surfaces both through the ready contract. This pin returns to a stable
  release once 4.0.16 ships. A project with its own `extension` install
  is unaffected, and `EXTENSION_MCP_CLI_VERSION` still overrides.
- `extension_deploy` and `extension_store_status` advertise `safari`
  again: the platform's Safari/App Store submission lane is now enabled
  for every project, so the store enum and the per-store status report
  treat it like chrome, firefox, and edge.
- `extension_list_templates` and `extension_get_template_source` resolve
  the template catalog and sources from the pinned, content-addressed
  corpus served at `media.extension.land`, with a commit-pinned GitHub
  raw fallback. Both tools previously read a floating `nightly`/`main`
  ref, so two runs could disagree; they now resolve one immutable
  release whose files are sha256-verified at the origin.
- Console and dashboard links come from a shared URL contract and are
  environment aware, so a local or development run no longer hands back
  hardcoded production console URLs.

### Added

- `extension_dev` accepts `carrier: true` (Chromium-family sessions): it
  places the bundled Extension.dev Live Preview carrier in the project's
  `./extensions` folder, which Extension.js auto-loads as a companion
  beside the extension under development. Pages the carrier allowlists
  (inspect.extension.dev, localhost) can then pair with the live session
  and stream its real-lane chrome.* session trace over the carrier's
  event port. The copy is marker-guarded: an existing unmanaged
  `extensions/extension-dev-live-preview` directory is never overwritten,
  and the tool result reports what happened either way. The prebuilt
  payload ships in the package under `extensions/live-preview`.

## 5.6.1

### Changed

- `extension_deploy` and `extension_store_status` no longer advertise
  `safari` as a store. The Safari/App Store submission lane does not
  exist yet (the platform now also rejects such submissions server-side
  with `SAFARI_LANE_DISABLED`), so the tool schemas stop inviting agents
  to try it. Safari as a build/run target is unchanged.

## 5.6.0

Firefox reaches full protocol parity: every formerly Chromium-only
feature now works on Gecko, over RDP or the agent bridge.

### Added

- `extension_list_extensions` works on Firefox-family sessions. It rides
  the Remote Debugging Protocol root actor's `listAddons` over the
  `rdpPort` the engine stamps into ready.json from extension.js 4.0.15
  on (upstream entry 78). Entries list INSTALLED add-ons regardless of
  live contexts, `temporarilyInstalled` marks temporary loads, and the
  dev session's extension is flagged `ownExtension` by matching the
  ready contract's identity (with a lone temporary install as the
  fallback signal). Add-on targets are never attached to or evaluated
  in; system and hidden add-ons are filtered out. Older engines get a
  hint naming the 4.0.15 requirement instead of a generic failure. A
  minimal RDP client (`src/lib/rdp.ts`) carries the handshake; legacy
  RDP was chosen over WebDriver BiDi on purpose, since BiDi is
  single-session and would block attaching alongside other consumers.
- `extension_dom_inspect` listTargets works on Firefox: RDP tab
  descriptors as `{actor,url,title,type}`, with the same two-id-space
  warning as the CDP path (an actor id is not a chrome.tabs id).
  Discovery therefore needs no allowControl on Gecko, unlike listTabs.
- `extension_source_inspect` closes its four Gecko gaps. dom_snapshot
  and extension_roots ride the bridge eval, embedding the same CDP page
  scripts Chromium uses (the bridge html path also gained the
  shadow-aware serializer, so open extension-root shadow content is in
  the markup now). console rides the RDP watcher's cached-resource
  replay (`getWatcher` with server target switching, then
  watchResources; verified live that `getCachedMessages` is a dead end
  on current Firefox), summarized in the same shape as the CDP console
  buffer. deepDom walks CLOSED shadow roots through
  `tabs.executeScript`, where Firefox exposes
  `Element.openOrClosedShadowRoot` to content scripts, so it needs an
  MV2 session with host permissions for the target url; a failed walk
  reports why in `notes` instead of silently dropping the field.
- MV2 page-eval fallback: the engine's page-context eval needs
  chrome.scripting, an MV3-only API, so Firefox MV2 sessions reported
  every bridge inspection as Unsupported. The inspect expression now
  falls back to compiling in the tab's content-script sandbox via
  `tabs.executeScript`, which reads the identical DOM; callers see the
  same result shape on both paths.

### Fixed

- Act-verb CLI output over ~8KB no longer truncates. The engine CLI
  exits without draining stdout, and the socketpair pipe Node hands a
  child buffers about 8KB, so any larger `--output json` frame (a DOM
  snapshot, a big html capture) arrived cut mid-JSON and surfaced as
  "CliError: extension exited with code 0". The MCP now hands the child
  file descriptors and reads them after exit, which no pipe buffer can
  truncate. Filed upstream as extension.js ledger entry 79; the
  workaround stays until the engine flushes before exiting.

### Known limitation

- Firefox MV3 sessions cannot use the bridge extras: the MV3 event page
  CSP blocks the eval the control bridge dispatches through the
  background, exactly like Chromium MV3 service workers. MV2 sessions
  are fully covered via the executeScript fallback. The RDP paths
  (list_extensions, listTargets, console) work on both manifest
  versions.

## 5.5.2

Honest browser support wording ahead of the Safari lane landing.

### Changed

- The package description and README now say Safari is coming next
  instead of listing it alongside the browsers that are store-ready
  today. Chrome, Edge, Firefox, and every Chromium- or Gecko-based
  browser remain fully supported; nothing changes functionally.

## 5.5.1

The store journey stops being write-only after submit, and the token
surfaces start telling the truth about lifetimes and API bases.

### Added

- `extension_store_status` (tool 33): the post-submit sibling of
  `extension_deploy`. Reads the project's public registry
  (`stores/health.json`, `stores/status.json`, `stores/submissions.json`)
  and reports per store whether it is configured, its latest credential
  health check, the last recorded submission (version, status, store
  URL, submitted-at), and the latest review status. Normalizes both the
  v3 merged status schema and legacy v2 poller documents. Defaults to
  the logged-in project; accepts `workspace` + `project` overrides like
  `extension_release_list`. A configured store with a failing credential
  reports `configured: true` with `health.ok: false` (rotate the
  credential, deep-linked), never "not configured".

### Fixed

- `extension_whoami` no longer asserts a bare `api` field that could
  misstate the platform base (a login minted via a localhost dev server
  kept reporting that dead base for a token that authenticates against
  production). The recorded login base is now labeled
  `apiRecordedAtLogin`, `apiDefault` reports what authenticated tools
  actually target, the message flags any divergence, and a set
  `EXTENSION_DEV_TOKEN` is disclosed as outranking the stored login.
- The 7-day token TTL (server-enforced) is now stated everywhere a CI
  author looks: `extension_login`'s description and success/pending
  results, `extension_whoami`'s `tokenTtlNote` (with the deep console
  Access tokens URL), and the auth prose of `extension_deploy` and
  `extension_release_promote` (`extension_publish`'s auth envelope is
  byte-frozen and unchanged).
- `extension_deploy`'s description says the per-store rows in the result
  are the verdict to trust: the platform's bare preflight line does not
  check store health. A real (non-dry-run) submission now points at
  `extension_store_status` for tracking.

## 5.5.0

The debug surfaces learn to point at things: tabs are targetable by
URL, extensions in lists have names, and eval works on the default
template by default.

### Added

- `extension_dom_inspect` targets tabs by `tabUrl` (case-insensitive
  URL substring, title as fallback). Exactly one match inspects it and
  the result names the resolved target; zero or multiple matches return
  the candidate targets instead of guessing. `listTargets: true` lists
  the browser's live CDP page targets (targetId, url, title, type) with
  the standing warning that a CDP targetId is NOT a chrome.tabs id.
- `extension_list_extensions` names its entries. The dev session's own
  extension resolves to `name`, `version`, and `ownExtension: true`
  (identified by recomputing Chrome's unpacked-extension id from the
  ready contract's distPath) and sorts first; entries that cannot be
  resolved carry a note saying why instead of a silent bare id. Other
  extensions' contexts are never attached to or evaluated in.

### Fixed

- `extension_eval` works on the default template by default. On
  Chromium with an MV3 manifest the default context is now `page` (the
  MV3 service worker CSP blocks background eval), disclosed in the
  result as `defaultedContext` with the reason; explicit
  `context: "background"` is unchanged and keeps its CSP explanation.
  Firefox and MV2 defaults are untouched. A defaulted eval that lands
  on an unreachable active tab returns a hint to navigate or pass
  `url`/`tab`.
- Error remedies speak tool arguments, never CLI flags: the engine's
  `--context page --tab <id>` prose is rewritten into `context:`/
  `tab:`/`url:` vocabulary, with guards so ordinary prose is never
  garbled by the rewriting.
- The debugging documentation's headline example now runs on the
  default template (page-context eval); the background variant is
  labeled MV2/Firefox, and the cross-browser matrix states per-context
  eval support honestly with the MV3 CSP footnote.

## 5.4.0

The DevX swarm's non-blocker friction clusters, cleared: waiting is
narrated, ports tell the truth, artifacts say where they are, and error
prose explains the extension instead of the engine.

### Added

- `extension_wait` narrates its budget. `timeoutMs` is a documented
  argument (default 45000, clamped 1000 to 50000; the legacy `timeout`
  spelling stays as a deprecated alias), every result carries `budgetMs`
  and `elapsedMs`, and a timeout says what WAS observed plus a
  call-again hint instead of an opaque failure. The status splits
  `compiled` from `browserAttached`, and a `noBrowser` build-only
  session returns immediately with `buildOnly: true` and a plain
  statement that no browser will ever attach.
- `extension_build` with `zip: true` returns `zipPath`, the absolute
  path of the file the engine actually wrote (its name sanitizer strips
  punctuation, so the filename rarely matches the project name), and
  `zipSourcePath` for `zipSource: true`. When a zip cannot be located
  after a successful build the result says so in `zipPathNote` instead
  of omitting the field silently.

### Fixed

- `extension_dev` reports the actually-bound port. The engine's
  ready.json carries the bound port from its first stamp, so dev reads
  it after the health window and re-registers the session with the true
  port; when the stamp has not landed yet, dev claims no port at all
  and says `extension_wait` reports the bound one. dev and wait now
  share one source of truth and cannot disagree about the same session.
- `extension_build` warns when it writes over a live dev session's
  dist: the dev browser may serve the production artifact until the
  next recompile. The build is never blocked; the clobber is named.
- `extension_inspect` classifies `.zip` files as archives and excludes
  them from `shippableSize` and the 10MB store gate (the package is not
  payload), with an `archiveNote` explaining the exclusion.
- `extension_whoami` anchors its identity to the stored token that
  `extension_login` minted: it does not follow the current working
  directory, and the wording now says so.
- `extension_open` explains a popup-less extension instead of relaying
  the engine error: a manifest pre-check reports that nothing sets
  `action.default_popup`, lists the surfaces the manifest DOES declare,
  and points at the right next verb. Headless popup errors state the
  exact headed path (`extension_dev` with `replace: true` and
  `EXTENSION_HEADLESS=0`).
- `extension_dev`'s `earlyOutput` drops V8 asm.js verdict lines (pure
  noise); real errors are preserved.

## 5.3.1

### Added

- `extension_login` pending results lead with the one-click device link
  when the flow provides one (RFC 8628 `verification_uri_complete`): the
  user opens it and approves with the code pre-filled, no typing. The
  bare URI and code stay in the result as the fallback for flows that
  cannot prefill.
- `extension_deploy` and `extension_release_promote` accept each other's
  spelling for the same build commit: deploy folds a `buildId` argument
  onto its canonical `buildSha`, and promote folds `buildSha` onto its
  canonical `buildId`. Full-schema validation errors enumerate the new
  aliases alongside the rest of the contract.

### Fixed

- Resuming `extension_login` with a `deviceCode` while authorization is
  still pending no longer claims a userCode of "(see the previous
  response)". Only a hash of the code is stored, so it cannot be echoed
  again; the result now says plainly that the one-click link and code
  from the previous response are still valid, to open that link (or
  enter the code at the verification URI), then call `extension_login`
  again with the same deviceCode.

## 5.3.0

The DevX surprise swarm ran ten personas over the full create-to-release
journey and ranked five blocker clusters. All five land here.

### Added

- `extension_release_list`: the discovery sibling of the release verbs.
  Lists the project's channels (channel to promoted build sha) and recent
  builds from the public registry (registry.extension.land), so a caller
  can pick a valid `buildSha` for `extension_release_promote`,
  `extension_deploy`, or `extension_publish` instead of hunting the
  console. Read-only, needs no auth for public projects. Tool count is
  now 32.
- A shared public-registry client (`src/lib/registry.ts`) that reads
  meta, channels, the build index, and store credential health. Reads
  are best-effort: a registry blip never fails the verb it decorates.

### Fixed

- `extension_create` announces every decision it took without being
  asked. The resolved destination path leads the result, and
  `defaultsApplied` names each silent choice (server cwd, package
  manager, browser, git init) as one. Validation errors now teach the
  full argument schema, required, optional, and aliases, instead of
  revealing one missing field per attempt.
- `extension_dev` no longer forks sessions. A second call on the same
  projectPath used to return ok:true while its browser died on the
  profile lock; it now detects the live session and refuses, or stops it
  first with `replace:true` and says so. A dead browser leg no longer
  rides an ok:true envelope: the ready contract's `browser_exited` stamp
  and the profile-lock signature both surface as failures.
- `extension_stop` finds orphaned sessions. It unions the in-memory
  registry with the on-disk session markers, so a session whose dev
  child exited (exactly when the orphaned browser most needs stopping)
  is still found, verified, and reaped. A stale marker yields an honest
  stopped:false and is pruned, never a phantom kill.
- `extension_deploy` dry runs stopped echoing an unqualified
  "Preflight OK". The preflight now reads per-store credential health
  from the registry and reports each browser as actionable, not
  configured, or unverifiable, with the console stores URL in the
  result. The silently defaulted channel is disclosed and checked
  against channels.json. Under dryRun a platform error now reads
  "preflight failed", never "submit failed".
- `extension_release_promote` dead-ends carry the way out: a 404 or
  UNKNOWN_BUILD error now includes each channel's currently promoted
  sha, the registry URL it read, and the console Builds page URL, plus
  a pointer to `extension_release_list`.
- `extension_publish` says what the share link serves: the build sha,
  build time, version, and channel behind the URL, resolved from the
  registry's build index, with a note when it is the newest successful
  build rather than a pinned one.

## 5.2.0

### Added

- `extension_manifest_validate` warns when a Chrome-desktop-only manifest
  key (for example `file_browser_handlers`) rides an Edge target, where it
  is inert. Family-level prefix resolution already worked; this adds
  granularity inside the chromium family for Edge-targeted publishers.
- `extension_logout` now returns `revokeUrl` pointing at the project's
  access-tokens page and says plainly that the token stays valid
  server-side until revoked there. The scope is read before the local
  credentials are cleared so the link can still be built.

## 5.1.2

### Fixed

- `extension_logs` no longer flags a healthy live session as stale. Newer
  engine canaries stamp log and event rows with ready.json's `instanceId`
  rather than its `runId`, so the staleness check compared ids from two
  different spaces and every live read carried `stale: true` with a
  do-not-trust warning. The comparator now accepts either identity field,
  pinned by a test against the real contract shapes. (Filed upstream as
  Extension.js bug 77 so the ready/logs contract agrees on one field.)

## 5.1.1

### Added

- `extension_deploy` warns when a Firefox or Edge submission ships without
  the STORE.md notes the platform submits automatically (Firefox reviewer
  and release notes, Edge certification notes). The warnings ride along in
  the result as `warnings` and never block the submission; Chrome-only
  submissions stay silent.

## 5.1.0

The engine closed its entire open bug range (Extension.js 61-73) in the
4.0.14 canary line. This release re-aligns the MCP with the fixed engine,
finishes the MCP-side half of those bugs, and continues the
report-failure-not-false-success program that 5.0.0 started. 5.0.0 was never
published to npm; installing 5.1.0 picks up both.

### Fixed

- **Sessions now genuinely survive the MCP process.** `detached: true` alone
  never did it: the child held pipes to the MCP, so when the MCP exited the
  next compile log line killed the dev server with EPIPE. Launch tools
  (`extension_dev`/`start`/`preview`) now stream the child's output to a
  session log file (returned as `logPath`) instead of pipes. A detached
  session outlives the MCP and a fresh MCP process rediscovers it through
  `ready.json` and can stop it. Pinned by a detach-contract test.
- **`extension_preview` no longer reports `launched` for a process that died
  in seconds.** It health-checks the child like `dev`/`start` (the MCP half of
  engine bug 72), and all three launch tools read the engine's new
  `browser_exited` stamp, so a browser that dies after launch (for example a
  rejected add-on) returns `status:"browser-exited"` instead of success.
- **`extension_doctor` names a dead browser.** A `browser_exited` ready
  contract now produces a runtime-errors failure that says the browser died,
  with the matching remedy, instead of the generic "fix the build error"
  wording that pointed at a build that was fine.
- **`extension_create` verifies the scaffold.** A resolved create over a
  partial tree (an interrupted template download) returned `nextSteps`
  pointing at a project that could not compile. It now checks the manifest
  exists and returns `status:"incomplete"` when it does not.
- **`extension_manifest_validate` is per-target honest.** `chromium:`/
  `firefox:` prefixed keys resolve per target, `edge` joins the default
  matrix, `manifest_version` must be 2 or 3, a `default_locale` without its
  `_locales` catalog blocks, and a missing 128px store icon warns
  (`extension_inspect` reports `has128Icon`).
- **Stale state stops being served as live.** `extension_logs` stamps
  `stale:true` when the producing session is dead or from a different run;
  `extension_wait` returns `runtimeErrors` alongside ready instead of a bare
  green over a crashing worker; `extension_build` reports
  `productionDivergence` when the production manifest lost permissions or
  resources relative to source.
- **`extension_open`'s `asTab` fallback fires on the user-gesture wall**, and
  `extension_storage` set without a `key` answers in MCP vocabulary rather
  than CLI flags.

### Added

- **Structured bundler warnings on `extension_build`.** The engine now
  persists its build summary to `dist/extension-js/<browser>/
  build-summary.json` (the transport half of engine bug 73), and the tool
  returns it as `buildWarnings` (with `buildWarningsTruncated` naming the
  true count when the engine capped the list). Older engines simply omit the
  field; nothing is scraped from stdout.
- **Popup-faithful headless rendering.** A popup rendered as a tab is now
  sized like the real popup: the document's content size is measured over
  CDP, clamped to Chrome's 25x25-800x600 popup bounds, and the window is
  resized to it (reported as `renderedAsTab.popupBounds`). If the browser
  does not verifiably honor the resize, the tool keeps saying "no popup
  sizing" instead of implying fidelity. Note headless-new is one such
  browser: it accepts `Browser.setWindowBounds` and changes nothing, so
  headless sessions get the honest fallback, not a resized window. The
  measurement also leaves `body`'s authored width alone; only the root takes
  the temporary fit-content override, so a popup that sizes itself through
  `body { width }` measures at its real width.
- **CI typechecks the tests.** `pnpm typecheck` covers `src/` and the test
  tsconfig, wired into the CI matrix, so type drift between tools and their
  tests cannot accumulate silently again.

### Changed

- **Tool prose caught up with the fixed engine.** `extension_eval` and
  `extension_dom_inspect` now advertise the surface contexts
  (`popup`/`options`/`sidebar`/`devtools`) and override pages
  (`newtab`/`history`/`bookmarks`) the engine's relay serves, needing no tab
  id. The "content eval is known-broken" guard is version-honest: on
  Extension.js >= 4.0.14 a null is the expression's real result, and the note
  says so instead of condemning a repaired path. Firefox hints name every
  working route.

A pass focused on a single question: when something has gone wrong, does the
tool say so? Five tools were reporting success over a failure. All five now
verify before they claim anything.

### Breaking

- **`extension_build` refuses a broken build.** It runs the
  `extension_manifest_validate` checks as a preflight and returns
  `status:"blocked"` on build-blocking errors instead of shelling out to a build
  it knows is broken. Pass `skipValidation: true` for the old behavior. It also
  returns `success:false` with `status:"incomplete"` when the bundler exits 0 but
  a declared entrypoint never reached `dist/`, because the browser refuses to
  load that artifact. Non-blocking findings ride along as `manifestWarnings`.
- **Browser resolution defaults to `chrome`, not `chromium`.** A dead session
  used to fall through to a blind default, so every call after a dev server
  exited silently retargeted a browser the caller never ran. A dead session now
  resolves to its own browser with `source:"stale"`.
- **`extension_open` renames `tab` to `target`.** The value is a CDP target id,
  not a `chrome.tabs` id, and the old name invited callers to pass it straight
  into tools that need a numeric tab id.

### Fixed

- **`extension_doctor` no longer reports `healthy:true` over a crashing
  extension.** Its runtime-error check read the wrong field, so every error row
  in `logs.ndjson` collapsed to an empty string and was skipped. It now reads the
  engine's `messageParts` payload, with an `errorName`/`stack` fallback, and
  collapses a throw that repeats on every event.
- **`extension_dev` and `extension_start` no longer report `status:"started"`
  for a server that already exited.** Both health-check the child process and
  return `status:"exited"` with the exit code, signal, and the child's own output
  as evidence.
- **`extension_open` no longer reports success for a navigation that failed.**
  Navigating to a `chrome-extension://` origin is cross process and swaps the
  render frame, so the pre-navigation session reported a stale error URL on
  success and success on failure. It now confirms against a fresh target list.
  This affected the `url` navigation path shipped in 4.9.0, not only the new
  surface rendering.
- **`extension_open` targets the right extension.** A dev session also loads
  Extension.js's own manager extension, and taking the first extension target
  navigated against the wrong origin. The id is now derived from the dist path
  the session actually loaded.

### Added

- **Headless surface rendering.** `extension_open` accepts `asTab` for
  `popup`/`options`/`sidebar`, rendering the surface document in a real tab so it
  can be inspected where no window exists to host a popup. It is applied
  automatically when a headless session refuses to open the surface, with a note
  saying what was substituted.
- **Tab targeting by url.** `extension_eval` and `extension_dom_inspect` take a
  `url` and otherwise default to the active tab, and `extension_dom_inspect`
  gains `listTabs` for discovery. The engine gained this in 4.0.13; the tool
  descriptions had been telling callers a numeric tab id was required.
- **Friendlier arguments.** `timeoutMs`, `lines`, `tabId`, `href` and
  `browserName` fold onto their canonical names, `withConsole` accepts `true`,
  and the input validator understands union types.
- **`extension_create` matches your package manager.** Hints and the engine
  warning now use bun, pnpm or yarn when that is what the scaffold used, and the
  warning reads the pin the scaffold actually wrote.

## 4.9.0

A second pass from the persona swarm, closing the gaps 4.8.0 left and the top
new blockers it surfaced.

- **Honest `extension_manifest_validate`.** It now scans the project source for
  permission-gated `chrome.*`/`browser.*` calls and flags any the manifest does
  not declare, an API used without its permission is `undefined` at runtime and
  crashes the context, the exact case where validate used to report `valid:true`.
  The headline is now honest (`valid:false` + `buildBlocking:true` on any error),
  and it accepts singular `browser` as an alias for `browsers`.
- **`extension_open` can navigate a tab.** Pass a `url` (Chromium, via CDP) to
  drive a content-script test page, a `webNavigation` target, or the popup as a
  page (`chrome-extension://<id>/popup.html`), the loop the surface-only open
  could not do. `target` is accepted as an alias for `surface`.
- **`extension_stop` actually reaps the session.** It now terminates the dev CLI
  and both browser families (gecko profile + chromium `--load-extension`, under
  the project's dist) and refuses to report `stopped:true` while any survive.
- **`extension_wait` won't lie about a dead session.** A `ready.json` whose pid
  is dead now returns `status:"stale"` instead of `ready`, so you don't walk into
  a reload/eval that fails with a misleading control-channel error.
- **Dropped-channel errors name the real cause.** A `1006` / "no control channel"
  now detects an exited dev server (stale ready.json + dead pid) and says so,
  instead of asking "is the session started with allowControl?" when it was.
- **`extension_doctor`** surfaces recent error-level logs as a `runtime-errors`
  check (so a background throwing on every event isn't `healthy:true`), keeps the
  project-local engine version in project mode, and flags when that engine
  differs from a pinned `EXTENSION_MCP_CLI_VERSION`.
- **`extension_build`** lists declared entrypoints in its success output, so a
  content script no longer reads as "didn't build".
- **`extension_create`** forces non-interactive git (`GIT_TERMINAL_PROMPT=0`) so a
  credential prompt can't hang the template download, retries once on a transient
  network/timeout failure (cleaning the partial dir first), reports a download
  failure as such instead of "choose a valid template name", and warns when the
  scaffold's `extension@latest` pin will win over your pinned CLI.
- Eval/inspect error guidance now speaks MCP JSON args (`context`, `tab`, `url`)
  instead of CLI flags.

## 4.8.0

Dev-session ergonomics hardened from a 30-persona agent walk of the toolchain.

- **`allowEval` now implies `allowControl`.** Enabling eval on `extension_dev`
  also opens the control channel, so a single `allowEval: true` unlocks
  `extension_storage`/`reload`/`open`/`dom_inspect` too. `extension_dev` now
  returns a `capabilities` block naming exactly which verbs the session unlocked,
  ending the stop-and-restart loop that hit agents who passed one flag and not
  the other.
- **Session-aware browser default.** `extension_stop` (and the other
  browser-scoped tools) resolve the browser from the one live session for the
  project instead of assuming `chrome`. `extension_stop` also reaps the launched
  browser's process tree and refuses to report `stopped: true` while a process
  survives, fixing orphaned browsers (notably Firefox) after a stop.
- **Forgiving argument names.** Common synonyms are accepted and normalized:
  `path`/`dir` for `projectPath`, `name` for `projectName`, `template` for
  `slug`, `code` for `expression`, and more, so a reasonable first guess no
  longer 400s.
- **`extension_manifest_validate`** accepts `projectPath` (it finds the
  manifest) and probes path-valued fields (popup, service worker, icons, content
  scripts) against disk, warning on dangling references instead of a false
  all-clear.
- **`extension_doctor`** inlines the dev session's own recorded errors so a build
  or load failure no longer reads as healthy.
- **`extension_inspect`** lists declared entrypoints (so a small content script
  is not buried under assets) and warns when a store-listing promo image is
  shipped inside the package.
- **`extension_source_inspect`** on a Gecko session now names the working
  alternatives (`extension_logs`, `extension_eval`) instead of pointing back at
  the tool that just refused.

## 4.7.0

`extension_deploy` now submits **through** extension.dev instead of driving a
local CLI. Pass `browsers` + `buildSha` and the submission is routed to the
platform, which holds your store credentials and dispatches the release from
your project's mirror CI; authentication is your `extension_login` session or a
release token in `EXTENSION_DEV_TOKEN`, and it defaults to a dry run. The tool
is now a thin authenticated client of the platform's store-submission endpoint,
exactly like `extension_publish` and `extension_release_promote`, with no
external CLI dependency. This replaces the previous mode that shelled out to a
standalone local CLI. Direct zip-based submission with store credentials in the
environment is no longer exposed through the MCP; use your own CI pipeline for
that.

## 4.6.0

New `extension_deploy` tool (31 tools total): submit a built extension to the
Chrome Web Store, Firefox AMO, and Edge Add-ons by driving a standalone
deploy CLI. Store targets are inferred from the `.zip` paths
you pass. It defaults to a dry run, and store credentials are read from the
environment or a `.env.submit` file, never from tool arguments, so secrets
never enter the agent transcript.

## 4.5.0

The platform client (GitHub device-code login, the credential store, and the
publish flow) is now vendored directly in this package instead of the
separate `@extension.dev/core` dependency. No behavior change: the tool
schemas, the credential file, token resolution, and the publish error
envelopes are all unchanged. This drops a runtime dependency and the
two-package release step.

## 4.4.0

Browser-matrix parity release: the tool surface now mirrors the engine
CLI flag for flag, and a 30th tool cleans up the managed browser cache.

- New tool `extension_uninstall_browser`. Removes a managed browser
  binary from the Extension.js cache (or every one with `all: true`).
  Only touches the managed cache, never system-installed browsers.
- Full Extension.js browser matrix in `extension_detect_browsers`: all
  eleven supported browsers (chrome, chromium, edge, brave, opera,
  vivaldi, yandex, firefox, waterfox, librewolf, safari) are probed,
  each reported with its engine family and whether the managed
  installer can provision it.
- Shared browser-launch flags on `extension_dev`, `extension_start`,
  and `extension_preview`: `profile` (path, or `"false"` to reuse the
  default user profile), `startingUrl`, `chromiumBinary` /
  `geckoBinary` custom binaries, `host` / `publicHost` for Docker and
  devcontainer splits, and companion `extensions` loaded alongside the
  project.
- `extension_build` closes its gaps against the engine CLI:
  `zipFilename`, `polyfill`, `silent`, and `mode`
  (development/production/none, also sets NODE_ENV).
- Engine dependencies bumped to ^4.0.11.
- The shipped debugging docs are rewritten around the live inspect
  surface.
- Release plumbing: npm publishes now carry provenance from a
  changelog-backed GitHub workflow, the npm README renders the logo at
  the right width via pack hooks, and the Safari web extension keyword
  aids npm discovery.

## 4.3.0

Diagnosis + version-skew release: a 29th tool that turns "an act tool
errored, now what" into one call, and a CI that tests the engine
versions users actually run.

- New tool `extension_doctor`. Wraps `extension doctor --output json`:
  walks the dev session's control-channel legs (ready contract,
  dev-server process, control-port agreement, control channel, eval
  token, executor, browser liveness) and returns one
  `{check, status, detail, remediation?}` entry per leg in dependency
  order. Detail and remediation prose are rewritten to MCP-speak like
  every other act-verb error. Engines that predate the `doctor` verb get
  a clean CliError with a hint instead of a crash.
- Browser-family classification now has ONE copy
  (`src/lib/browser-family.ts`). Fixes real drift: `browsers:
  ["chromium"]` ran ZERO family checks in `extension_manifest_validate`
  (an MV2 manifest validated "fine"), and `chromium` was still missing
  from the `extension_build` / `extension_dev` / `extension_preview` /
  `extension_start` schema enums.
- CI version-skew matrix: every push builds and tests against the
  engine canary, the latest stable, and the vendored floor (deduped),
  plus a nightly run that exercises the real `npx extension@<pin>` path
  end-to-end (`RUN_CLI_SMOKE=1`). A red canary cell now surfaces engine
  regressions the day they publish instead of on the next unrelated PR.
- Legacy ready-contract compatibility suite: fixtures pin the contract
  shapes older engines wrote (no `cdpPort`, no `pid`), so a 4.0.6-era
  session stays visible to browser defaulting and `resolveCdpPort`
  refuses to adopt an unrelated developer Chrome instead of probing a
  bogus port.

## 4.2.2

Agent-ergonomics release from the 4.2.1 fresh-eyes walk: the two changes
that removed nearly all friction a real MCP client hit.

- Session-aware browser default. Tools that target a running session
  (`extension_logs`, `extension_reload`, `extension_eval`,
  `extension_storage`, `extension_open`, `extension_dom_inspect`,
  `extension_list_extensions`, `extension_source_inspect`,
  `extension_wait`) no longer hard-default `browser` to a constant that
  could disagree with the session `extension_dev` actually started.
  Omitting `browser` now resolves to the active session's browser:
  in-memory registry first, then the freshest live `ready.json` contract
  on disk (dead pids ignored), then the old constant. Starting a session
  with `browser: "chrome"` and calling `extension_logs` with no args now
  just works instead of erroring about a missing chromium channel.
- Error hints speak the MCP tool surface, not the CLI. Act-verb error
  prose is rewritten before returning: `` `extension dev
  --browser=chromium --allow-control` `` becomes `extension_dev with
  { browser: "chromium", allowControl: true }`, and stray
  `--allow-control` / `--allow-eval` / `--browser=<x>` mentions become
  their tool-argument names. Result data is never touched, only
  error/hint prose. Tool descriptions now name `allowControl` /
  `allowEval` directly, so agents no longer discover the gates by
  fuzzing the schema.
- The no-channel error now names the session that IS running ("Active
  session browser(s) for this project: chrome, pass that as `browser`"),
  so an agent retargets instead of spawning a second, conflicting
  session. Same for the `extension_logs` follow miss.
- `extension_list_extensions` / `extension_source_inspect` accept
  `browser: "chromium"` (the default dev target) instead of rejecting it
  as non-Chromium.
- Tests: session-browser resolution + hint-translation suite (137 total).

## 4.2.1

`extension_build` failures no longer kill the MCP server process
(fatal-error path returned a rejected promise the server didn't catch).
CDP-dependent tools resolve the debug port from the session's ready
contract instead of assuming 9222 (plus a test-only engine pin
override, `EXTENSION_MCP_CLI_VERSION`).

## 4.2.0

Session lifecycle + determinism release. Tool count 27 -> 28.

- New tool `extension_stop`: terminates a dev/start/preview session (dev
  server AND the browser it launched) via a process-group signal with
  SIGTERM -> SIGKILL escalation. Finds the pid in the in-memory session
  registry, falling back to the `ready.json` contract when the MCP server
  restarted since the session began, and removes the stale contract so
  `extension_wait` cannot report a dead session as ready. Supports
  `all: true` to stop everything the server started.
- Sessions self-clean: dev/start/preview register an exit listener so a
  session that dies on its own is no longer reported as stoppable.
  `extension_preview` sessions are now registered (and stoppable) too.
- `extension_create` gains `parentDir`: control where the project lands
  instead of inheriting the MCP server's working directory. `nextSteps`
  now reports the full project path.
- CLI spawns are deterministic: dev/start/preview and the act tools now
  prefer the project's own `node_modules/.bin/extension`, falling back to
  `npx extension@<pinned>` where the pin derives from the vendored
  `extension-develop` version, never a floating `latest`.
- Session registry keys are path-normalized, so a stop with an absolute
  path matches a session registered with a relative one.
- Tests: registry suite now asserts against the exported `tools` array
  (the old hand-maintained mirror had drifted to 26 while the server
  registered 27); new stop + CLI-resolution suites (123 tests total).

## 4.1.2

README: restore the `@extension.dev/skill` pairing section (hands +
judgment) now that the skill is public on npm. No code changes.

## 4.1.1

README rewritten for the public npm page: Extension.js-style header
(badges, tagline, quick start), tool table updated to the full 27-tool
surface (release-promote was missing), and links to private repos or
npm-restricted packages removed. Package description tool count fixed
(26 -> 27). No code changes.

## 4.1.0

The MCP now consumes `@extension.dev/core` for all platform-auth logic
(core MIGRATION.md phase 2). No tool schema changes, no behavior changes:
the JSON-string envelopes are byte-compatible and pinned by tests.

- New dependency `@extension.dev/core` ^0.2.0: device-code login, credential
  store, and publish client now live there, shared with every other surface.
- Deleted `src/lib/credentials.ts`, `src/lib/github-device.ts`,
  `src/lib/login-flow.ts` and their migrated tests; `login`, `whoami`,
  `logout`, and `release-promote` import from core.
- `tools/publish.ts` is a thin adapter over core's `publish()`; the frozen
  PublishAuthError / PublishConfigError / PublishNetworkError / PublishError
  envelopes and the success passthrough are pinned by a new
  `publish-envelope` test.
- New `core-boundary` regression test: no file under `src/` may redefine the
  credential store or import auth primitives from anywhere but
  `@extension.dev/core`.
- CI and Release workflows pass `NPM_TOKEN` to the install step (core is
  npm-restricted until the public flip).

## 4.0.8

Tracks the `extension` 4.0.8 suite (the versioning convention: this package's
version follows the CLI suite release it pairs with). One tool was added since
3.17.0, `extension_release_promote`, bringing the surface to 27 tools.

- Bump `extension-create`, `extension-develop`, `extension-install` from
  ^3.13.5 to ^4.0.8. All consumed APIs (`extensionCreate`, `extensionBuild`,
  `extensionInstall`, `getManagedBrowsersCacheRoot`) and all CLI verbs the
  tools shell out to (`dev`, `start`, `preview`, `logs`, `eval`, `storage`,
  `reload`, `open`, `inspect`, `publish`, including `--allow-control`,
  `--allow-eval` and `--no-browser`) are unchanged in 4.x; verified
  end-to-end (create -> build -> dev ready contract -> manifest validate).
- `package.json` version now matches the published line (was a stale 0.0.1)
  and the server reports its version from `package.json` instead of a
  hardcoded string (previously stuck at 3.13.5).
- `browser-extension-manifest-fields` ^2.2.8 -> ^2.2.9.
- vitest config: resolve the extension-* test aliases from the packages'
  exports maps; 4.x dropped the CJS entry, so `require.resolve` on the bare
  specifier no longer works.

## 3.17.0

First stable release on npm. The registry previously carried only canary
builds (3.17.0-canary.*), so `npx @extension.dev/mcp` resolved a canary;
this release graduates that line to stable and becomes `latest`.

- 26 tools across scaffolding, build/dev/preview, live inspection (CDP +
  agent bridge), act tools (eval/storage/reload/open), browser management,
  and platform auth/publish.
- Claude Code integration assets (CLAUDE.md, slash commands, rules) and the
  @extension.dev/skill pairing.
- MIT license shipped; repository moved to extensiondev/mcp.

# @extension.dev/mcp, Changelog

## 5.5.1, agent-bridge tools

Adds the MCP client surface for the Extension.js **agent bridge** (dev-time
observe + act + inspect). All new tools shell out to the `extension` CLI verbs
(lockstep invariant: the CLI is the single source of behavior), so they require
a recent **`extension` CLI that ships the bridge verbs** (`logs`, `eval`,
`storage`, `reload`, `open`, `inspect`, `publish`).

> ⚠️ **Release order:** publish this package ONLY after the `extension` /
> `extension-develop` suite that ships those verbs is on npm. The published CLI
> at the time of writing (`3.17.0`) does NOT have them, publishing this package
> before the suite would ship tools that fail with "unknown command". Bump the
> version + `extension-*` deps to that suite release, then publish.

New tools (22 total):

- **`extension_logs`**, read/stream logs from every extension context
  (background, content, popup/options/sidebar/devtools); filters
  `level`/`context`/`url`/`tab`/`since`, bounded `follow` window.
- **`extension_eval`**, evaluate an expression in a context (requires the dev
  session started with `--allow-eval`; MV3 service worker is CSP-gated).
- **`extension_storage`**, read/write `chrome.storage` (requires `--allow-control`).
- **`extension_reload`**, reload the extension or a tab (`--allow-control`).
- **`extension_open`**, open popup/options/sidebar (`--allow-control`).
- **`extension_dom_inspect`**, CDP-free DOM snapshot of content/page or an open
  surface (popup/options/sidebar/devtools); `withConsole` merges recent logs.
- **`extension_publish`**, publish to extension.dev and return a shareable URL
  (auth-gated; requires `EXTENSION_DEV_TOKEN`).
- **`extension_source_inspect`** gains **`deepDom`**, pierce CLOSED shadow roots
  via CDP (Chromium only).

Internal: `lib/act` (CLI shell-out helper), `lib/exec.runExtensionCli` (capture),
`lib/cdp.getClosedShadowRoots`. Test infra aligned to the workspace vitest
catalog.

## 5.5.1, login (auth tools)

Adds the missing `login` flow so `extension_publish` no longer requires the user
to mint and export `EXTENSION_DEV_TOKEN` by hand. Auth stays auth-AWARE: the
token lives in a local credentials file, never in the MCP process state or logs.

New tools (25 total):

- **`extension_login`**, GitHub **device-code** flow (no local server; works
  headless). Two-phase: call with `project` (`<workspace>/<project>`) to get a
  code + URL, call again with the returned `deviceCode` to finish. On success it
  writes a project-scoped token to the credentials file. Never returns the token.
- **`extension_whoami`**, report the stored workspace/project and token expiry
  without revealing the token.
- **`extension_logout`**, delete the local credentials file.

Token resolution for publish is now `EXTENSION_DEV_TOKEN` env **>** the
credentials file (expired file tokens are ignored).

Credentials file (versioned, `0600`): `$XDG_CONFIG_HOME/extension-dev/auth.json`
(or `~/.config/...`; `%APPDATA%\extension-dev\auth.json` on Windows).

Platform endpoints this depends on (in `apps/www.extension.dev`):

- `GET /api/cli/login/config`, public GitHub OAuth client id + scope.
- `POST /api/cli/login/exchange`, trades a GitHub **user** token for a
  project-scoped access token after checking workspace membership. Modeled on
  `/api/oidc/exchange`; tokens are recorded so they stay revocable.

> ⚠️ **Ops:** the device flow requires **device flow enabled** on the GitHub
> OAuth App behind `WWW_GITHUB_OAUTH_CLIENT_ID`. Until then, `extension_login`
> can't complete and users fall back to a dashboard-minted `EXTENSION_DEV_TOKEN`.
