# Changelog

## Unreleased

Built on Extension.js 4.1.36.

- Ledger 171. The preflight no longer asks for a push of a commit the build would not read. After a one-line STORE.md commit every store said "HEAD 5480e40 has no platform build yet; push it so the package checks read it", and under the monthly build cap that push spends a build on a package that cannot differ. When the build the checks read is an ancestor of the checked out HEAD, `extension_submit` preflight runs `git diff --name-only <built> HEAD` in `projectPath` and, when every changed path is one the platform build does not read (the platform's own `DOCS_ONLY` rule, `src/lib/build-inputs.ts`: markdown and license or notice files outside any `public/` directory; everything else, `.github` included, counts as read), says "HEAD 5480e40 changes only STORE.md, which the build does not read, so the package checks still hold for build 914c593 and no push is needed" and answers `packageBuild.holds {build, changed}`. The rule is conservative: a changed source, manifest, asset, data or workflow file, any file under `public/`, a built sha the local repository does not hold or that is not an ancestor of HEAD, an empty diff and a git that cannot run all keep today's words. The local read runs only when the platform has no build of HEAD to point at (no push record, an unreadable list, or a push the platform skipped or refused); a HEAD the platform classified docs only, a pending build and a dispatched push keep their sentences.
- Ledger (Leon walk, build cap). A push the platform refused over the build cap is named as refused, not as unpushed. After `git push` of 388861d the preflight said "HEAD 388861d has no platform build yet; push it" while `extension_builds` read `lastPush {commit: 388861d, outcome: QUOTA_EXCEEDED, dispatched: false}`. The preflight now reads that record and, for `QUOTA_EXCEEDED` or `PUSH_BUILDS_EXHAUSTED`, reads the workspace plan once per call (`GET /api/workspaces/<slug>/plan`, shared across the stores asked) and says "HEAD 388861d was pushed (received <time>) and the platform refused it over the monthly build cap (352 of 350 builds this month; the cap resets 2026-11-01T00:00:00Z); the newest submittable build is 914c593", the reset being the first instant of the UTC month after the plan's `month`. A plan that reads under the cap or cannot be read says "refused it as QUOTA_EXCEEDED (the platform's build counter refused the dispatch; extension_workspace info reads the allowance)" and never claims a cap it did not read; `PUSH_BUILDS_EXHAUSTED` keeps its words with the reset added; the newest completed build on the list is named as submittable, the read build when the list has none newer. Sync-listing's icon reason gives `QUOTA_EXCEEDED` its own step (the monthly build cap; `extension_workspace info` reads the allowance). The 352 of 350 counter is the platform's and was addressed by ledger 294.
- Ledger 314. `extension_submit {action: "status"}` and `extension_release_status include: ["stores"]` under an expired stored login answer `not-signed-in` / `E_AUTH_EXPIRED` before any call is made: "The login for <workspace>/<project> expired at <ISO time> (<how long ago>), so nothing was read or sent: this server drops an expired token instead of sending it, and the platform would have read the call as missing-token", with `value.login {project, expiresAt, expiredForSeconds, sent: false}`, a `login` next step naming `extension_auth {action: "login", project}`, and `value.trackUrl` on the store page (the one store's page for a one-store status, the Submissions page otherwise). The answer guessed "no stores configured yet" or "slugs may be wrong" (`StoreStatusNotFound`, Rebeccat, 2026-10-31) because the credential resolver drops an expired login silently and the registry then read "missing-token". A login `EXTENSION_DEV_TOKEN` or an approval token covers is not refused. Every registry read refused without a credential now says the same when the stored login expired (`src/lib/login-expired.ts`), instead of "This project is private".
- Ledger 315. The Safari `watch` step's re-read sentence names the tool that answered it: `extension_submit {action: "status"}` says to call `extension_submit {action: "status", browsers: ["safari"], waitSeconds: 180}` again, and `extension_release_status` keeps naming `extension_release_status {include: ["stores"], refresh: ["safari"], waitSeconds: 180}`. One sentence builder (`safariFreshReadCall`) takes the calling tool, passed through `readStores` and `safariNextStep`; the status answer told an owner runbook built on status/release to switch tools (Rebeccat, 2026-10-31).
- `extension_submit` answers the store version it sent as each row's `version`, never the build sha. Leon's walk (2026-10-31) submitted build 63f0d41 to four stores and every `submissions[]` row read `version: "63f0d41"` with `storeVersion: null`, while `extension_release_status` read 0.1.0.3 and 0.1.0.2 seconds later: the MCP names no `version` and the platform predicted the store version from that empty label alone. The platform now reads the built manifest's version from the build's own record (`builds/<sha>/<store>.json`, the file the preflight's `nextVersion` reads) when the call names none, so www answers `version: "0.1.0"` and `storeVersion {packaged: "0.1.0.3", ...}` (www `src/services/stores/built-version.ts`, both submit routes); this server then answers every `submissions[]` row's `version` as the packaged store version, read from the dispatch answer or from the record once it names one (`rowsWithSentVersion` in `src/lib/store-answer.ts`), and the sha stays only where no build record could be read. The `version` input says so, and says that a submit takes no channel: a submission is the stable release of its build for that store (Cezar, 2026-10-28), and the channel a row carries is the channel that pins the build on the registry, when one does; the preflight no longer blocks on `submission.release_selected`, a check no caller could satisfy since the label went away (www `src/features/stores/submission-readiness.ts`). Ledger 167.
- Every package address a tool prints is the build's own extension.dev address, `https://<workspace>.extension.dev/<project>/builds/<sha>/<browser>.zip` (`firefox.xpi` where the registry serves the signed package), never a `registry.extension.land` address and never a token. The Hands-free Chrome preflight told the owner to create the store item "with this package" and named a 330-character registry address carrying a JWT in its query string, while `extension_builds` named the same file at a registry address with no token, so one file had two addresses and the owner read a domain that was not the product's and a token they did not ask for. `extension_submit` (preflight, the submit and publish refusals, the dry run) now computes `value.packageUrl` and the `sayToPerson` sentence from the workspace, project, sha and browser this server knows (`src/lib/package-address.ts`), mapping a platform-answered address by its `builds/<sha>/<file>` path and, for a shape it cannot map, from the build sha alone, so a tokened registry address is printed nowhere in the answer and the connection row carries the package as `packageFile: "builds/<sha>/chrome.zip"`; `extension_builds {action: "get"}` answers every `artifacts[].downloadUrl` through the same helper, so the submit tools and the build read name one string for one file; `extension_publish` rewrites the platform's run commands to that address, carrying the share grant as `?share=<id>` (the short id when the platform minted one, else the share link's own grant), so the held-page run line reads `npx -y extension@latest preview "https://<workspace>.extension.dev/<project>/builds/<sha>/chrome.zip?share=<id>" --browser=chrome` beside "It works until <date>", and a command carrying `share=` now counts as carrying the grant (the `[?&]t=` test that told a private project's short commands they needed no token is widened). Local dev, where userland runs on a path and no function serves the route, keeps the platform's own address and its `?t=` run command as they are. Ledger 306.
- `extension_builds {action: "get"}` rewrites a package row's `downloadUrl` only. The ledger 306 rewrite mapped every `downloadUrl` carrying `builds/<sha>/` to the `https://<workspace>.extension.dev/<project>/builds/<sha>/<file>` shape, metadata (`chrome.json`), integrity (`artifact-integrity/chrome.json`) and executable rows included, while the platform route serves package files alone (`<browser>.zip`, `.xpi`, `.crx`) and www keeps the other rows at their tokenless registry address, so the answer printed a 404 for them. Package rows take the subdomain address and every other row passes through as www answered it; the registry-and-token guard covers package rows and `sayToPerson`, not the whole envelope. Ledger 309.
- A `- Category:` line under a store's own section is that store's category. STORE.md carried `- Category: Accessibility` under `## Listing`, right for Chrome and Edge, while AMO has no Accessibility category, so the Firefox listing preflight blocked on a name the owner could not express, and `- Category: Other` added under `## Firefox Add-ons` was not read (sync-listing answered `unchanged`): a store section's own lines took every key but the category. The parser now reads a `- Category:` line under `## Chrome Web Store`, `## Edge Add-ons`, `## Firefox Add-ons` or `## Safari` (at the top of the section or under any of its `###` sub-headings, a trailing parenthetical kept out of the value) as that store's category in place of the `## Listing` value, for that store alone, ahead of a `(Firefox: <name>)` note on the Listing line. Where no such line exists and the Listing name is not one of a store's own categories, a built-in map (`src/lib/store-categories.ts`, the Chrome, Edge and AMO vocabularies beside it) sends the nearest name that store has, Chrome's Accessibility reaching Firefox as Other, and `sync-listing` says so: "Firefox has no Accessibility category, so Other was sent; add `- Category:` under `## Firefox Add-ons` to choose another." The sync body still carries `listing.categories` per store; each store's row answers `categories {sent, from: section | note | listing | mapping, mapped?}`, and when the stores differ `sayToPerson` and the hint say which value each store got: "Firefox category: Other (from the Firefox Add-ons section); Chrome and Edge: Accessibility (from Listing)." The preflight's category shape, the STORE.md field reference (the store section in the Category line's also-read column, the per-store rule) and the `extension_submit` description name the line. Ledger 312.
- `extension_submit {action: "status"}` never says a store check landed beside a read older than its dispatch. The answer said `refreshWait {landed: true}` and "these are the states it read" with `stores[0].readAt` 14 minutes before `refresh.safari.dispatchedAt` (Rebeccat, 2026-10-31): the landed test counted a poll lane run, while the platform writes a submission's `statusRead.readAt` only when the word changes, so an unchanged Apple word kept the older stamp. `stampPollRunRead` (`src/lib/store-read-landed.ts`) moves the row's `statusRead.readAt` and `storeReview.checkedAt` to the store check's run time when the check this call dispatched ran the store's lane (`ran: true`, a record checked) at or after `dispatchedAt` and the row's word was read by a poll, so an unchanged word reads `(poll at <run time>)` and the Safari step says `read at <run time>`; `pollLanded` then means the row's read time is at or after the dispatch, a lane run counts only for a row with no read time, and a row whose read is still older (the lane did not run, checked nothing, or the word came from the publish answer) answers `landed: false` with "these are the states before it (safari was read at <readAt>, before the dispatch at <dispatchedAt>)" and the `watch` step. Ledger 310.
- `extension_submit {action: "status"}` about one store answers one console link. A Safari-only status named `https://console.extension.dev/<workspace>/<project>/submissions` in `stores[0].nextStep.url` and `nextStep.url` while `value.trackUrl` named `.../submissions/safari`, two links for the same thing (Rebeccat, 2026-10-31). The Safari step's url is now the store's own page (`ConsoleProjectPage.submissionsStore`), the same string as `trackUrl`; a status whose answer holds one store names that store's page as `trackUrl` even when no `browsers` was passed, and the plain Submissions page stays only for an answer that spans several stores (`extension_release_status`'s `consoleStoresUrl` is unchanged). Ledger 311.
- The Firefox preflight's `updateManifest.manifestUpdateUrl` echoes the manifest's `update_url` whenever one exists. It answered `null` beside a `say` that read "Firefox will look for updates of this self-distributed version at <address>" (build 4b5ae18, 2026-10-31): the local read needs `projectPath`, and www's passing check carries the address in its message and not in `actual`, so the matched path set nothing while the mismatch path did. `updateUrlOfCheck` reads the check's `actual` when it is an address and otherwise the address a passing check's message says Firefox will look at; `manifestUpdateUrlOf` reads `browser_specific_settings` (or `applications`), `gecko` and `update_url` under the bare, `firefox:` and `gecko:` key shapes Extension.js writes for the firefox target. A manifest naming the platform's address yields `manifestUpdateUrl` equal to it with no warning, the relayed check carries it as `actual` on the matched path too, and `null` means no manifest names one. Ledger 313.
- The Chrome item and the Edge product ask for their first package by hand in one sentence. The `extension_submit` preflight routed the same hand upload two ways: `requirements.items[chrome.item].how` and the Chrome `sayToPerson` named a package address and no download call, while `requirements.items[edge.product].how` (the platform's words) named the `extension_builds` download call and no address, so an agent reading both told the owner two procedures for one act. Both rows, and the Chrome `sayToPerson`, now say one sentence built by `src/lib/hand-upload.ts`: "Download <browser>.zip of build <sha> at https://<workspace>.extension.dev/<project>/builds/<sha>/<browser>.zip, or let me save it with extension_builds (action: \"download\", buildId, browser); upload it once as the item's first package.", followed in both by the note that every later platform upload carries the store version `<manifest version>.<n>` (with the next one when the platform names it) and by what each store still needs (the Chrome item's dashboard address, the Edge Product ID). A row the project already has keeps the platform's words, and neither row can name a registry address or a token. Ledger 307.
- The Firefox preflight names the platform's update manifest instead of sending the owner to host one. The `firefox.update_url` check told the owner "Point update_url at an https update manifest you host" and keep it current after every signed build, the one chore a release platform exists to do. The platform hosts a Mozilla update manifest per Firefox release channel at `https://<workspace>.extension.dev/<project>/channels/<channel>/updates.json`, each version's `update_link` at `.../channels/<channel>/firefox.xpi`, both token-free and rewritten after every signing, so `extension_submit` preflight relays the platform's check text as it is once it names that address and otherwise says: "Put browser_specific_settings.gecko.update_url: <address> in the manifest for the firefox target; the platform rewrites updates.json after every signing." in `value.stores.firefox.updateManifest` (`channel`, `updateManifestUrl`, `channelXpiUrl`, `manifestUpdateUrl`, `say`) and in the hint; the check is no longer a warning, except when the project's manifest (read from `projectPath`, or the check's own `actual`) names a different `update_url`, where it warns and names both addresses, platform silence included. `extension_release_promote` (a promote that queued firefox) and `extension_publish` (a channel that serves firefox) answer `value.firefox {channel, updateManifestUrl, channelXpiUrl}` and say the address in the hint; chrome alone gets none, and a private project, whose channel link is withheld, gets none either. Both addresses come from `updateManifestAddress` and `channelXpiAddress` beside the package address in `src/lib/package-address.ts`; a tokened or expiring address is never an `update_url`. Ledger 308.
- A STORE.md justification bullet keyed by a host pattern is read. The `### Permissions justification` reader took a key that could hold no colon, and every host pattern holds `://`, so `- *://*/*: <reason>` was dropped whole (the Hands-free sync-listing answered `unchanged` and read five of six bullets) while the preflight kept asking for that very bullet. A bullet's key now ends at the first colon followed by a space, or at a colon that ends the line, and loses the backticks or quotes around it, so `- *://*/*: <reason>`, `- https://*.example.com/*: <reason>` and `` - `*://*/*`: <reason> `` all read; the local host read takes a bullet whose key or reason names the pattern (an exact match, or a glob such as `*://*/*` that covers it), and a `listing.chrome_host_justifications` warning or a `chrome.permission_justifications` row naming a pattern the file does not name asks for it in the form that works, one example verbatim. The STORE.md field reference and the `extension_submit` description name that form. Ledger 302.
- Before the first sync-listing, a Chrome preflight sentence about STORE.md says what the file holds. The platform's `chrome.permission_justifications` row read "STORE.md has no `### Permissions justification` bullets" and the `distribution.chrome_visibility` check and `chrome.visibility` row read "STORE.md has no `- Visibility:` line" of a file that carried both: they read the platform's listing record, which the first sync fills. With `projectPath`, this server reads the file with the sync's own parser and answers "not synced yet (STORE.md carries 6 bullets under `### Permissions justification`): run extension_submit {action: \"sync-listing\", browsers: [\"chrome\"]}" and "STORE.md carries `- Visibility: unlisted`, not synced yet" instead; a file that carries nothing keeps the platform's words. The `- Visibility:` line, and every other `- Key:` line of a store section, is now read anywhere inside `## Chrome Web Store`, at the top of the section or under any of its `###` sub-headings (the Hands-free file had it under `### Visibility` and the reader took only the lines above the first `###`), and the field reference and the tool description say so. Ledger 303.
- `extension_project_create` and `extension_auth (action: login)` wait for the approval inside the call. Both answered `authorization-pending` at once with "approve, then call again with this deviceCode right away", so each approval cost a chat round trip and a code the owner saw late (minted 16:59Z, dead 17:14Z) was lost. Both tools take `waitSeconds` (0 to 900, clamped to the code's remaining life) on the call that carries `deviceCode`: it polls the grant on the platform's interval (longer on `slow_down`) and answers `created` or `logged-in` in the same call the moment the owner approves, `authorization-pending` with `waitedSeconds`, `expiresAt` and `expiresInSeconds` when the bound passes first (the hint names the exact resume call with the seconds left), and `create-expired` / `login-expired` saying a new code is needed and to call again without `deviceCode` when the code dies meanwhile. The first call never blocks, since it carries the link the owner has to open; a `waitSeconds` on it is answered with a warning naming where it applies, and every pending answer carries the code's `expiresAt`. The platform has no grace for a late approval (`app/api/cli/device/token/route.ts` expires the code at `createdAt + 900 s` and the record's store TTL is the same 15 minutes), so the answers say so. Ledger 292.
- A new project is one approval. The create answer said "The provisioning grant stays valid until it expires" and sent the agent to `extension_auth login`, which minted a second code for the owner on the same page. `extension_project_create` takes `login` (default true): the token the platform mints with the create (`tokenIssued`, `token`, the shape its batch create already answers) is stored as the new project's login, `value.login` answers `{stored: true, project, expiresAt}`, `nextSteps` drops the `extension_auth` line and the hint says no extension_auth call is needed; when the platform answers no token the hint reads "The platform answered no project token on this grant (<code>), so one more approval is needed: extension_auth (action: login, project)" and `value.login` carries `{stored: false, reason, message}`, the same for a replayed create (a replay carries no token), a token that could not be stored, and `login: false` (the token is discarded). The platform's single create (`PROVISION_LANE`) mints no token yet; only its batch lane does. Ledger 293.
- `extension_start` waits for the build and the browser the way `extension_dev` does. It answered `started` 5 s after the spawn with "the contract has not recorded a browser launch yet; extension_wait reads it once the build lands", so an `extension_open` sent next answered `no-session` and every production check cost an `extension_wait` first (four times in the soccer-broadcast session). The start now runs the same wait `extension_dev` runs (the `extension_wait` handler on the ready.json contract, up to 45 s after the 5 s boot check) and, once the build lands, answers the wait's own `build-ready` (or `ready`, when the controlled copy's background attached) with the session beside it: `pid`, `verb`, `allowControl`, `controlPort`, the extension id, `cdpPort`, `extensionLoaded` and `loadEvidence` read over the debug port, `waited {status: "landed", budgetMs, elapsedMs}`, and a hint that opens with "The build landed and chrome loaded the extension within N ms of the spawn, so no extension_wait is needed". A wait that runs out keeps the `started` answer with `waited {status: "timeout", budgetMs, elapsedMs}` and a hint that names the exact `extension_wait {projectPath, browser}` call to keep waiting; a build that fails after the boot check answers the wait's own `contract-error` (or `stopped`, `browser-gone`) with the session in `value`. `wait: false` answers as soon as the engine process is alive 5 s after spawn, as before, and a `noBrowser` start never waits. The schema carries `wait` (default true) and the description says so. Ledger 297.
- A debug-port verb sent while an `extension_start` run is still landing waits for the port within its own `timeout` instead of refusing `no-session`. `extension_open`, `extension_eval`, `extension_screenshot`, `extension_dom_snapshot`, `extension_inspect`, `extension_list_extensions` and `extension_assert` all resolve the port through `resolveCdpPort`, which read the ready.json once, gave a port-less contract 2.5 s of grace and refused; a verb sent during a `wait: false` start, or fired before the start answer landed, answered `no-session` every time. The resolver now reads the start receipt (and the dev contract) the way ledger 278 and 297 do: while it says a run is landing (the engine process alive, no `cdpPort` stamped yet, status `starting` or `ready` without the port on an engine that stamps one, a registered live run whose receipt is not written yet, or a receipt that still describes the run being replaced), and the run's own deadline (the 5 s boot check plus the 45 s wait `extension_start` itself runs) has not passed, the resolver keeps polling the same contract until the port appears, bounded by the verb's `timeout` (passed through from each verb; the resolver's 20 s default otherwise), and the verb answers normally with a `warnings` line "This call waited 1.2 s for the chrome extension_start run to land (its ready.json read status starting when the call arrived) before answering". No run, a dead engine, a build error, a pre-4.1.34 engine that never opens a port, or a deadline already passed keep today's immediate refusal, so a dev-session verb with no session is not slowed; callers that ask for no wait (`waitMs: 0`, the wait tool's own load oracle and the doctor) never wait. Ledger 304.
- An `extension_assert` verdict no longer says "this platform cannot cover the question today" when the only cause is a page that is not open yet. `page-world-clean` on a url no target matched answered that sentence beside a `settledBy` that said to open the page. A check now carries `reason: "not-ready"` when a precondition is missing, and the hint counts those apart: "1 not ready, a precondition this platform covers once it is met (not a platform limit, not a bug in the extension): the page this check reads is not open: open it with extension_open (url: ...), wait for it to load, then assert again"; the "cannot cover" sentence stays for a real platform limit (a Gecko session for a CDP read, for one). Better, `page-world-clean` with a full url (no `*`) and no matching target opens the page itself through the navigation `extension_open {url}` runs, re-reads the target list and judges the landed page, with `evidence.openedByCheck` naming it; a url pattern is matched, never opened, and stays not ready with the hint, and an open that lands no page answers not ready naming the navigation's own answer. Ledger 298.
- The `extension_assert` description no longer says the checks run "against a live dev session" or to "Start the session with extension_dev". `page-world-clean`, `no-outside-requests` and `background-worker-booted` read the browser over its debug port and are meant for the production build (`extension_start` with `allowControl: true`), whose runtime carries none of the dev stubs `page-world-clean` would otherwise have to discount; `storage-key-present` needs the control channel (`extension_dev`, or `extension_start` with `allowControl: true`); `content-script-injected` and `console-errors-empty` read the dev session's log stream, which a production session has none of, so they run on `extension_dev` only. The description now says all of that, within its 500-character ceiling, and names not ready beside inconclusive. The shared sentences follow: the no-session `settledBy` of every check reads "Start the session with extension_dev, or extension_start with allowControl: true for the production build, then assert again", the no-session detail says "No session with a debugging port", the `projectPath` argument of the session tools says "needs a running session: extension_dev or extension_start", and the environment doctor's hint names both session kinds. Ledger 299.

- Local tools reload a rebuilt build the way platform tools have since ledger 248, so a rebuild no longer needs `/mcp`: the owner ran it seven times in three hours of the soccer-broadcast session because `extension_start`, `extension_wait` and `extension_assert` kept the code the process had loaded, warned once on whichever call came first, and the verdict then read `producer.version 10.18.1+a4ffd3d`, `outcome pass`, as if the rebuilt code had passed. Local tools were held back because the dev-session registry lived in the dispatching module's scope (a reloaded build would have started blind to the browsers already running: its fork guard and `extension_stop all:true` read that Map), not because of the child processes, which are stopped by pid and found again by their marker files. The registry, the remembered extension targets and the one-recovery-per-session set are now one process-owned object (`src/lib/local-state.ts`) that every rebuilt build adopts by reference through the reload handover, so the generation that spawned a session and the one answering now read the same maps; a tool the rebuild added is listed and dispatched from the rebuilt build too. When a local tool cannot reload (the import failed, or the build on disk cannot adopt this process's sessions, told apart by the handover it echoes back) every one of its answers carries the warning with the reason, `value.server.stale: true` with `newerBuild {version, builtAt}`, and a verdict's `producer` carries `stale: true` and `newerBuild`, so a pass from held code can never be reported as the rebuilt build's. Ledger 300.
- Every envelope names the build that answered: `value.server {version, commit, builtAt, startedAt, pid}` is stamped on every answer the dispatcher lets out, refusals included (`unknown-tool`, `invalid-arguments`, a tool's own `bad-request`, an internal error), where before only platform answers and assert verdicts carried a version. After an `/mcp` had loaded a `main` checkout without ledger 268 to 274, `extension_assert` refused `page-world-clean` as an unknown check with nothing saying which server answered, and finding out took a `git log` in the clone and another `/mcp`. A check id this build does not know but the build on disk declares (read from that build's check list through the reload module, `assertChecksRebuilt`) is now refused before the stage runs as `server-stale` / `E_SERVER_STALE`: "This server predates the check page-world-sealed: it was built at X, the build on disk at Y declares it, and <why it could not reload>; run /mcp and pick extension-dev, then assert again", with `value.predates` and the newer build's stamp. Ledger 301.
- A platform call given a directory whose project no stored login is for answers `no-login-for-project` / `E_NO_LOGIN_FOR_PROJECT`, never `project-mismatch` / `E_PROJECT_AMBIGUOUS` with another project's login as the way out. An `extension_submit` preflight on the Hands-free directory, while `extension_project_create` for it was still waiting on the owner's device code, offered the Rebeccat and Leon logins. The hint now reads this machine's own records for the real next step: a create waiting for approval (`extension_project_create` writes it to `pending-creates.json` beside the logins and drops it once the code is spent) is named with its approval link, code and deadline; a held provisioning grant with its deadline and the resume call; a project this machine created with the login call alone; and otherwise `extension_project_create` with the project and repo, then `extension_auth (action: login)`. A preflight carries the local half beside the refusal, `value.local` per store (the STORE.md lines found and not found, the skipped lines and the icon) with each store's readiness `unknown` until the project has a login. The same answer reaches `extension_shares` and `extension_preview_web` through the shared binding; a call that names no directory keeps the `project-ambiguous` list. Ledger 287.
- A reloaded answer says when the client's tool list is older than the build that validated it. Ledger 285 told the client the list changed only on the first reloaded answer, and a process that predates that fix cannot tell it at all: the Rebeccat session's server had started on the 13:40 build, hot-reloaded ee63464's dispatcher (so `extension_submit {action: "status"}` was accepted and answered `status-read`) while its own `tools/list` handler and notification code stayed the old process's, so the client's schema never gained `status`, `release` or `buildNumber` and no `notifications/tools/list_changed` was sent. `createToolSurface` now tracks the build the list was served at against the build answering: while they differ, every reloaded answer carries `value.server.listStale: true` and `listedAt` next to `builtAt`, its hint says to list the tools again, and `notifications/tools/list_changed` goes out once per build, only while the client's list is stale; `tools/list` then serves the rebuilt schema and the flag clears. `value.server` also carries `startedAt` and `pid`, so an agent can tell a process that predates a rebuild and name the pid to end. When the listed schema is still old after `/mcp`, the process it reconnected to is an old one: run `/mcp`, pick extension-dev, Reconnect; if the schema stays old, quit and reopen the Claude Code session, or end the stale `extension-mcp.js` pid that `ps -axo pid,lstart,command | grep extension-mcp.js` shows (Rebeccat, 2026-10-30). Ledger 289.
- The Chrome preflight says the owner's step once, explains every id `storePreflight` names, and says once which build the package checks read. `value.sayToPerson`, `value.nextStep.say` and `hint` each carried the 600-character link-item sentence with the signed package URL (about 12 KB an answer); `sayToPerson` now carries it alone and `hint` and `nextStep.say` carry one line pointing at it, on the preflight, the submit refusal and the publish refusal, and the Chrome Web Store goal instruction names `value.sayToPerson`. `storePreflight.<store>` dropped the platform's `checks` rows, so `blocking: ["chrome.package_description"]` and `warnings: ["chrome.privacy_policy_for_user_data"]` named ids nothing in the answer explained (the platform had explained both: the manifest description was over Chrome's 132 characters); it now carries `checks[]`, one row per id in `blocking` and `warnings` with the platform's label, severity, status, expected, actual, message and docs URL, and an id the platform listed with no row of its own says so in its `actual`, naming `POST stores/<store>/submissions/preflight`. With `projectPath`, the build ids the package checks name (`of build <sha>`) are compared with the checked out commit; when they differ, `value.stores.<store>.packageBuild {read, head, say}` and the hint say once "the package checks read build 154767e; HEAD dcd8a23 is pending on the platform: build dcd8a23 of the checked out commit is building on the platform, not completed", read from the commit's own build record, and nothing is said when the checks read HEAD. Ledger 296.
- The preflight and sync-listing consult the push record before asking for a push. The platform skipped a README-only commit (`extension_builds` read `lastPush: {outcome: "DOCS_ONLY", dispatched: false}`, right) and the same minute the preflight said "HEAD 91931d7 has no platform build yet; push it so the package checks read it" and sync-listing said "the checked out commit 91931d7 has no platform build; push it, or pass useBuild with a completed build": both compared HEAD with the build list and never read the `lastPush` the same list answer carries. Both now read it from that one builds call (the preflight reads the list once for every store asked, not once per store, and a commit the record says was never dispatched is not looked up by its own record). When HEAD's push was received and the platform classified it `DOCS_ONLY`, the preflight's `packageBuild.say` reads "HEAD 91931d7 changes docs only; the package checks read 82c26be, the newest build, which carries the same package" with `packageBuild.headPush {outcome, receivedAt}`, and sync-listing reads the icon from the newest completed build, each store's row naming `build` with that sha and `value.iconSource {from: "build", build, reason}` saying the same; no push is asked for. When the outcome is another configured skip (`PATH_FILTERED`, `BRANCH_FILTERED`, `PULL_REQUEST_BUILDS_OFF`) or a refusal (`PUSH_BUILDS_EXHAUSTED`, `DISPATCH_DISABLED`, `FORK_PULL_REQUEST`), both say that word, when the push was received and what to do (push inside the root directory or to the deployment branch, `extension_builds {action: "rebuild", buildId}`, the allowance read); a push the platform dispatched whose build is not listed yet says so; and with no push record for HEAD, the "push it" sentences stay as they were. Ledger 305.
- A `sync-listing` not given `screenshots` answers the ones the listing record keeps. The second Chrome sync of the Hands-free walk (STORE.md changed, no screenshots passed) answered `filled` without screenshots and the `pasteInDashboard` row `{field: "screenshots", from: null}` while the record held both, because the paste row and the images sentence read only the screenshots this call sent. The read-back after the write now carries the store's screenshots requirement row: a call that sent none answers `value.stores.<store>.onRecord {screenshots}` with the platform's own count and sizes, the paste row reads `from: "<count> on the extension.dev listing record, kept from an earlier sync-listing; this call sent none"`, and the sentence says the record keeps them and which image rows they clear; when the record could not be read back the row reads `onRecord {unread}` and the paste row says `not read: ...` instead of null, and `from: null` is answered only when the record was read and holds none. `filled` still lists what this call sent. Ledger 290.
- `extension_builds {action: "list"}` answers one word for a build's state. The platform's list clears a row's `conclusion` while its run is active but keeps the registry's `summaryStatus` beside `status: "building"` and a running clock in `duration`, and the row read the summary as the conclusion, so hands-free 154767e listed as `status: "building", conclusion: "success", duration: "3m 44s"` with the hint "the latest is 154767e (building)". Every row's `status` is now one of success, failed, cancelled, building, pending or partial, read from the platform's status and conclusion words (`completed` + `failure` is failed, `in_progress` is building, `queued` is pending); a running row carries `startedAt` and `runningFor` and no `conclusion`, `completedAt` or `duration`, and a finished row carries its verdict with its start, end and duration. Ledger 291.
- `extension_builds {action: "list"}` never contradicts itself. The fabricated `createdAt` (a copy of `startedAt`, which moved from the run's clock to the build record's between two reads of hands-free 154767e) is gone; every timestamp in the list, `lastPush` and `headLag` is written as ISO seconds in UTC; a finished row whose start and end are one platform stamp (f939a95 read `startedAt` = `completedAt` = `17:45:22Z` beside a 34-second duration) answers that stamp as `timestamp` with a warning, never as a start and an end; a running row with no browsers carries `browsersNote` and the hint says the platform has not reported them yet; and a `lastPush` the platform recorded as `DEBOUNCED`, `DEFERRED` or `HEAD_QUEUED` with `dispatched: false` names in `lastPush.build` the listed row that built that commit, with a hint sentence saying the platform queued the push and then built it (the push record keeps its arrival outcome), or that it folds into the branch's next dispatched build when no row carries it yet. Ledger 295.
- `extension_workspace {action: "info"}` warns when the month's builds run low: under 10 remaining or under 5 percent of the allowance, the hint leads with "8 builds remain of 350 this month; each project creation and each push spends one" and `value.allowance {used, limit, remaining, warning}` carries it, with `warning: null` above the threshold. `extension_project_create` reads the workspace's plan with a stored login of that workspace before the create request (one platform read, skipped when no such login exists), answers `firstBuild.spent: 1` for a dispatched first build, and `allowance.remains` says what was left before the call and what the first build leaves, with `allowance.remaining` and the same warning when it is low; with no count to read it keeps "never invents one" and adds that the first build spent one. The description says the first build spends one of the monthly allowance. The hands-free walk created a project and pushed three commits at 342 of 350 with no warning in any answer. Ledger 294.
- `extension_release_status {include: ["stores"]}` answers each store's `release` as the newest version the project sent, never an older superseded record. Rebeccat's Edge row read `release: edge 0.2.0.2 superseded on build 21abf99` (a submission retired on 10-24, absent from the shown history) and `review: superseded 0.2.0.6` while 0.2.0.7 was live and 0.2.0.9 was the newest draft, because the server took the first `storeReleases` row per store as the platform listed them and the platform listed by the record last touched, and the review line took the newest store answer on record, which a retired record the poll keeps checking always carries. The store and lane pickers now choose by version (then by submission time), so a newer www or an older one answers the same row, `liveRelease` keeps the live version beside it, the history sentence leads with the live version and the newest upload, and the review line beside an upload with no store answer of its own ranks a superseded record behind every other answered one. UI ledger, Edge release row, 2026-10-30.
- `extension_submit {action: "status", browsers: [<store>]}` reads the store's own state for the newest version: `value.stores [{store, submissionId, version, buildNumber, status, state, readAt, source, releaseType, nextStep}]`, from the same reader as `extension_release_status {include: ["stores"]}`, and with `waitSeconds` it asks for a store check first and answers once it lands. An unknown `extension_submit` action now names both reads in its refusal (Rebeccat, 2026-10-30).
- The tool list follows the build that validates the call. A server that reloaded a rebuilt build answered platform calls with the new build's schema while `tools/list` kept the schema it started with, so a client saw `extension_submit` without `release` or `buildNumber` while the server accepted both. `tools/list` now answers each platform tool from the active build, the server declares `tools.listChanged` and sends `notifications/tools/list_changed` on the first answer after a reload, and the action enum and the handler's own refusal come from one `SUBMIT_ACTIONS` list. The description names `status` and `release` (Rebeccat, 2026-10-30).
- `extension_submit {action: "status"}` and `extension_release_status {include: ["stores"]}` answer a store's newest submission from the platform's own record when the registry holds a row of the same build. The platform stamps a submission's `submittedAt` when it dispatches the run and the run appends the registry row minutes later, so by time alone the registry row read as the newer submission and the platform record was dropped as stale; Rebeccat's Safari status then read `submissionId: null`, `source: null` and `nextStep: null` with "no store read behind it" 47 s after saying the store check it asked for had landed, while the dropped record (b40be3ae, with `statusRead.source: "poll"`) sat in `submissionHistory` as an earlier submission. A registry row and a platform record of one build (sha, packaged version, build number, channel) are now one submission: the platform's fields win, the registry's own stay beside them, the release mode is the newer of the poll's `appStoreRelease` and the act's `publish.releaseType` (`releaseTypeReadAt` says when), the history no longer lists the latest record by its id, and the row carries `submissionId: "b40be3ae"`, `source: "poll"` and `nextStep {kind: "watch"}`. A newer registry row of another build still outranks the platform's older record. When a check landed after this call's dispatch and the platform still answered no source for the read, the status hint says exactly that instead of "no store read behind it", and its closing sentence reads "only a state a store check or the publish answer read grounds a next step". Ledger 288.
- The Safari row of `extension_release_status {include: ["stores"]}` carries `nextStep {kind, say, url}`: `watch` while a store check reads the version in Apple's review, `release` with `extension_submit {action: "release", browsers: ["safari"]}` once it reads `PENDING_DEVELOPER_RELEASE`, and none for an inferred or hand-recorded word. `refresh` takes `waitSeconds` and answers once the store check lands, with `value.refreshWait {landed, waitedSeconds, stores}`, so a fresh Apple state takes one call (Rebeccat, 2026-10-30).

- The still-starting answer of the debug-port verbs no longer says a run "was started without allowControl" when it was started with `allowControl: true`. `extension_open {url}` right after `extension_start {allowControl: true}` read the missing `controlPort` of a receipt still at `status: starting` as "no control" and told the agent to start again with `allowControl: true` and `replace: true`, which replaces a session that already had control. `extension_start` now records `allowControl` in the server's session registry (the in-memory entry and the session marker), and the receipt reads whether control was requested from the entry whose pid matches the contract's engine pid: a starting run that asked for it answers "This run asked for the control channel (allowControl: true in this server's session registry) and the contract has not recorded its port yet; once it lands, the bridge verbs reach it, and the debug-port reads need no control at all", a ready receipt with no `controlPort` whose registry entry says control was not requested keeps the "started without allowControl" sentence and names what it relies on, and a receipt with no matching registry entry carries no control sentence at all. The restart after a gone engine process names `allowControl: true` when the run had asked for it. The debug-port floor in the "names no debug port yet" hint reads Extension.js 4.1.34, the release whose production launch first stamps `cdpPort` (extension.js #840), not 4.1.36. Ledger 281.
- A production session's answers agree about the debug port and the load proof. `extension_start` said "a production launch opens no debug port, so the browser's target list cannot be read from here" in `loadEvidence` and its hint, then `extension_wait` answered `cdpPort: 9222`, `extensionLoaded: true` and "Read over the browser's debug port 9222: 2 live targets ..." next to `browserAttached: false` and a hint ending "To prove the load, run it with extension_dev", which replaces the production session it had just proven. Extension.js 4.1.34 is the first engine whose production launch opens the debug port and stamps `cdpPort` (extension.js #840), so the server now reads the engine off the contract's `toolchainVersion` (or takes an accepted `allowControl` as 4.1.34 or later, since older engines refuse the flag): on that engine `extension_start`'s `loadEvidence` says the engine stamps `cdpPort` once the browser binds it and `extension_wait` reads the load off that port's target list, and its hint names the exact `extension_wait` call instead of `extension_dev`; an older engine keeps "opens no debug port on a production run (4.1.34 is the first that does)" with its version named, and an unknown engine says what the next answer relies on. `extension_wait`'s start branch answers `browserAttached: true` when the load was read over the debug port, closes with "The load is proven over the debug port N, which extension_open {url}, extension_assert, extension_screenshot and extension_dom_snapshot by url read now; nothing here needs extension_dev" and names the bridge verbs that still need `allowControl: true`, says to call `extension_wait` again while a 4.1.34 or later engine has not stamped the port, and keeps "do not call extension_wait again" and the `extension_dev` proof for an older engine only; `debugPortNote` follows the same read. `PRODUCTION_SESSION_LIMITS`, `CONTROLLED_SESSION_LIMITS` and the `extension_start` description now say what a production session cannot do (no hot reload, no console stream for `extension_logs`, bridge verbs need `allowControl`) instead of that it opens no debug port, and the doctor's `debug-port` skip names the 4.1.34 floor. Ledger 282.
- `extension_doctor` diagnoses an `extension_start` session. On a live production session with the control channel the engine's doctor answered `ready-contract` fail ("the receipt of an extension start run, not a session contract", remediation "Start a dev session first"), skipped `server-process`, `port-agreement`, `control-channel`, `eval-token`, `executor` and `browser` as blocked, and the answer said `unhealthy` while its own `capabilities` read two live contexts over the debug port. When `ready.json` is a start or preview receipt and the engine's doctor does not pass it, the server now reads the legs itself from the receipt: `ready-contract` (status, control port and instanceId, or "no control channel (started without allowControl)"; a starting receipt fails naming the exact `extension_wait` call and says not to start `extension_dev`), `server-process` (the engine process pid, alive, gone or reused), `port-agreement` (skipped with why: a production run picks its control port per run and persists none), `control-channel` (connected over the bridge with its capabilities, or the engine's 4001 and 4003 refusals in production words), `eval-token`, `executor` (the storage probe, with the launch grace as a warn), `browser` (the launcher's browserPid, or skipped while no launch is recorded) and a new `debug-port` leg (the receipt's `cdpPort` answers, or skipped with why). A session without control skips the bridge legs naming `allowControl: true` and still answers healthy when the process, the browser and the debug port are up; `value.sessionCommand` says `start` or `preview`, the hint says what a production session can and cannot show, and no leg is "blocked by ready-contract". A dev session's answer is unchanged, and an engine whose doctor passes a production receipt is left alone. Ledger 277.
- The `E_NO_SESSION` answer of the debug-port verbs reads the start receipt before choosing its words. `extension_open {url}` right after `extension_start {allowControl: true}` answered "No active dev session / CDP port for chrome. Start extension_dev and extension_wait for ready", and following that replaces the production session with a dev one. One helper now answers `extension_open` (url and devtools), `extension_dom_snapshot`, `extension_inspect`, `extension_list_extensions`, `extension_screenshot` and `extension_eval` by targetId: a start or preview receipt that is still landing says the production session is still starting and names the exact `extension_wait {projectPath, browser}` call, never `extension_dev`; a ready receipt that launched the browser but names no `cdpPort` says the port is not stamped yet (an engine before Extension.js 4.1.36 never stamps one); a receipt whose engine process is gone says the run ended and names `extension_stop` then `extension_start`, or, when this server registered a newer run for the same browser, that the run is being replaced; a failed build names the errors; a run without `allowControl` says the debug-port reads work once it is up while the bridge verbs need `extension_start` again with `allowControl: true` and `replace: true`; a finished `extension_build` receipt says so. The engine's own control refusals on a bridge verb carry the same receipt words instead of "restart it via extension_dev without allowControl: false". A dev contract or no contract keeps every tool's wording byte for byte. Ledger 278.
- `extension_doctor`'s `project-engine` check reads the `extension` dependency `package.json` declares next to the copy `node_modules/extension` holds. A project pinning `extension@4.1.37-canary.1793360022.4f7af0f6` with a `4.1.36` checkout linked into `node_modules` was answered as "the project's extension@4.1.36" with no word on the drift. The check now warns when the installed version does not satisfy the declared one (an exact version, a canary pin among them, a `^` or `~` range, compared the way npm does), on every path: plain, under `EXTENSION_MCP_ENGINE_DIR` (where the override sentence stays first, since the project's own `npm run build` runs on the installed copy) and on a linked checkout; the detail says "package.json pins extension@<declared>, node_modules has extension@<installed>; the project's own build and tests run on the installed copy; run npm install (or pnpm install) to match" and the remediation names the install command the lockfile implies (`pnpm install`, `yarn install`, `bun install`, else `npm install`). A `workspace:`, `file:`, `link:`, `latest`, `npm:` or git spec is reported as declared without a comparison, a range the check cannot parse is reported as not compared and never warns, and a `package.json` with no `extension` dependency says so. `value.engineVersion` keeps the installed version and `value.engineDeclared` carries the declared spec or `null` next to it. Ledger 279.
- `page-world-clean` on a dev session no longer says the manifest declares no `world: "MAIN"` content script when the source manifest does. The dev build rewrites every MAIN-world entry of `src/manifest.json` into an isolated `content_scripts/dev-stub-*.js` loader, so the sentence was true of the running manifest only; the detail and `globals.bundles.note` on an `extension_dev` session now read "The dev build rewrites the N world: MAIN content script(s) of the source manifest (<files>) into isolated loaders, so no built bundle was searched; their globals are judged on an extension_start session", the source manifest read through the browser's view of its keys. A source manifest without a MAIN-world entry keeps the earlier sentence, and the production path is unchanged. Ledger 280.
- `EXTENSION_MCP_ENGINE_DIR` runs a local Extension.js checkout as the engine, so a session no longer waits for a canary dispatch or a stable release to carry a fix on the engine's main branch. The value is a compiled checkout root (the folder holding `programs/extension/bin/extension.cjs`) or a built `extension` package folder (holding `bin/extension.cjs`); `EXTENSION_MCP_ENGINE_BIN` names the exact bin file instead. While it is set, the one chooser every engine spawn goes through (`extension_dev`, `extension_start`, `extension_build`, `extension_preview_web`, `extension_create`, the capability probe, and `extension_doctor` itself) answers `node <that bin>` instead of the project's `node_modules/.bin/extension` or `npx extension@<pin>`, the engine sentence on `extension_dev` names the override path with the package's version and, when the folder is a git checkout, its short sha and branch (`detached` when there is none), and a path that holds no bin refuses the spawn naming the path and both expected locations, never falling back: `runExtensionCli` answers code 1 with the refusal, `spawnExtensionCli` answers no pid with the refusal as the spawn error, and `extension_doctor` answers `project-engine` `fail` before spawning anything. With a working override `project-engine` passes with "engine override: <path> (extension@<version>, <sha> on <branch>) is used for every spawn; the project's extension@<x> and the MCP pin are bypassed" and no remediation, and the no-project preflight's `extension-cli` check says the version came from the override. Independent of the override, a project whose `node_modules/extension` is a symlink to a folder outside any `node_modules` (an `npm link` or `pnpm link` to a checkout) passes `project-engine` as a "linked checkout" naming the real path, its version and sha, instead of being told a 4.1.35 checkout is older than the 4.1.36 pin; a pnpm store symlink inside `node_modules` is still compared with the pin. Cezar's ask, 2026-10-30.
- `page-world-clean` fails on a window global the extension's own build sets, even when its name does not carry the extension's id. The soccer-broadcast `extension_start` run passed with `__EXTENSIONJS_registerCleanup`, which the shipped `content_scripts/content-0.js` (a `world: "MAIN"` content script) plants on `window`, listed among the unknown globals. Two reads now settle it: a name with the Extension.js runtime's prefixes (`__EXTENSIONJS_`, `__EXTJS_`, `__extjs`, read case-insensitively) is the extension's own, and every other own window property the blank-frame baseline does not explain is searched for, as a whole word (`window.NAME`, `globalThis.NAME`, `self.NAME`, `NAME =`, a quoted `"NAME"`; a name under three characters only in its member form), in the text of each `content_scripts` file the running manifest declares with `world: "MAIN"` under the build folder. On a production session (`session.kind: "production"`) both fail the check, the fail sentence naming each global and the bundle that plants it; on a dev session the runtime's names are labeled `devRuntime` and excluded like the dev markers (the dev run had listed `__extjsDevContentScripts`, `__EXTENSIONJS_DEV_REINJECT__` and `__EXTENSIONJS_registerCleanup` as unknown), while a built global that is not a runtime name still fails. `pageGlobals` wins over both. The evidence carries `globals.engineGlobals` (`{name, file?, devRuntime?}`), `globals.builtGlobals` (`{name, file, devRuntime?}`) and `globals.bundles` (the files searched, those skipped with the reason, a file over 5 MB among them, and a note when the running manifest is the source one or declares no `world: "MAIN"` entry, so no bundle was searched); `globals.unknown` and its warning keep only the globals neither rule explains, and the pass sentence names the bundles searched. The `pageGlobals` description says it also exempts a name from these reads. Ledger 275.
- `extension_start {allowControl: true}` names the id the browser loaded. The answer hashed `.extension-js/<browser>/controlled`, a folder the engine never writes, for `controlledCopyId`, and took the contract's `extensionId` as the loaded id, which on a build longer than the 5 s read is the contract's first write, whose id the engine derives from `dist/<browser>` before it prepares the copy; the soccer-broadcast run answered the plain build's id as `extensionId`, a third id as `controlledCopyId`, a warning naming the same id twice, and searched the debug port for an id the browser never loaded. The copy's id now comes from the engine's own folder, `dist/extension-js/<browser>/controlled` under the project root, hashed by the real path Chrome registers; a contract id the browser answered (`extensionIdSource` `browser` or `packager`) is the loaded id, a derived id that equals the plain build's is replaced by the copy's and the warning says so, `value.extensionId` and `value.controlledCopyId` are that id, `value.extensionIdSource` says where it came from (`browser`, `contract`, `copy-folder`), the debug-port read looks for it, and the warning names two different ids. Ledger 276.
- A `url` or `tabUrl` with a `*` is read as a glob over the whole url, as the tool descriptions promised. `matchTargetsByUrl`, which picks the page for `extension_assert` (`content-script-injected`, `page-world-clean`), `extension_dom_snapshot`, `extension_eval`, `extension_open` and `extension_screenshot`, matched a substring only, so `https://www.youtube.com/watch?v=05ny1bmo-Kk*` found no page while `https://www.youtube.com/watch?v=05ny1bmo-Kk&t=1260s` was open and the exact url matched. A needle with `*` now matches when the whole url fits it, case-insensitively, with `*` spanning any run of characters (the query string included) and every other character literal, `?`, `.` and `+` among them; a glob no url fits answers no page instead of falling back to the literal `*` as a substring, and the fall back to the tab title reads the glob the same way. A needle without `*` is still a case-insensitive substring. `extension_logs` keeps the engine's own url matcher. Ledger 271.
- The producer of a build past the last release names the build. `value.verdict.producer.version` on `extension_assert` and `value.server.version` on every platform answer read `10.18.1` on a server compiled from a tree carrying unreleased fixes; the compile now resolves the short sha of HEAD and stamps `<version>+<sha>` (`10.18.1+48f1eba`) as semver build metadata, and the version stays bare on a release build (HEAD tagged `v<version>`, the release commit, or the release rail's bump built before it is committed), a canary, and a tarball without a repository; the module's `version` export the release gate reads is unchanged. `extension_assert`'s description says the check ids and each check's args are listed in the `expect` property. `extension_doctor`'s `project-engine` check no longer asks for a downgrade: a project engine newer than the MCP pin (a greater version, or a canary of the pinned base) passes and says the dev loop uses the project bin, and only an older engine keeps the `npm i -D extension@<pin>` remediation (the soccer-broadcast session was told to replace extension@4.1.37-canary with 4.1.36). Ledger 274.
- `extension_doctor` reads what the session browser computes on. On a Chromium dev session with a debug port the answer carries `value.capabilities`: `headless` (whether the `/json/version` Browser string or User-Agent says HeadlessChrome), the `browser` string, the `extensionId`, and `contexts`, one row per context the browser lists under the extension (the service worker, extension pages, offscreen documents, extension frames embedded in web pages, and workers), each with `kind`, `url`, `gpu` (`adapter` present or not with the reason, `vendor`, `architecture`, `device`, `description` from `adapter.info` or `requestAdapterInfo()`, the `features` list so `shader-f16` is readable, `limits.maxBufferSize` and `limits.maxComputeWorkgroupSizeX`, and `isFallbackAdapter`), `crossOriginIsolated`, `hardwareConcurrency` and `videoDecoder` (WebCodecs). A context that cannot be attached or whose probe throws or takes over 2 s answers its row with an `error` and never fails the doctor; a Firefox or Safari session, or a Chromium session without a debug port, answers `capabilities: null` with `value.capabilitiesReason`. The checks are unchanged. Ledger 270.
- `extension_assert` takes a `no-outside-requests` check: it attaches over the debug port to every target of the browser and to what runs under them (the service worker, extension pages, offscreen documents, dedicated workers inside them, and extension frames embedded in web pages, through `Target.setAutoAttach` repeated on each attached session), enables network events on each, and watches for `durationMs` (default 5000, up to 60000). A request from one of the extension's own contexts, or one a content script of the extension started in a web page, that goes anywhere but the extension itself, a loopback host or a data, blob or file URL fails the check, naming the url, the context that sent it and the script that started it, unless its host is in `allow` (a host name matches itself and its subdomains). The pass states the contexts watched by type, the requests seen and where they went, and that requests before the watch began were not observed; a window in which no context of the extension was alive, or a target that refused network events, is inconclusive, never a pass. Firefox and Safari sessions answer inconclusive, since the check reads the Chrome DevTools Protocol target list. Ledger 268.
- `extension_submit` names the version the next upload carries and where it lands (the Rebeccat Firefox run of 2026-10-29). `action: "preflight"` answers `value.storePreflight.<store>.nextVersion`, the number the platform will stamp, and for Firefox the AMO `channel`, the listed versions a listed upload `retires`, the versions awaiting review an unlisted upload leaves `untouched`, and the `landing` sentence; the hint says each. A dry run reads the same preflight: each `value.preflight[]` row carries the saved `publishMode` and the `nextVersion`, `value.nextVersions` maps them per store, and the hint names the saved submission mode instead of warning that it is "not readable with this token", which it said under the owner's own token; a store whose preflight did not answer its mode is named as such. A real submit answers the version the store received once the record has it, in `value.outcome.storeVersions` and on each `value.submissions[]` row whose dispatch answer had none. `extension_release_status` keys a Firefox review line on the version AMO holds, never on the build (one build reached AMO as 0.2.0.7 listed and 0.2.0.8 unlisted), and answers Firefox's releases one line per AMO channel, `amoChannels.{listed,unlisted}` on the firefox row of `value.stores`, so an unlisted upload no longer hides the listed version's review. A submit of several stores answers `value.outcomes.<store>` `{recorded, status, storeState, storeVersion, checkedAt, source, submissionId, trackUrl}`, one per store from its own record, and the combined line ("chrome: draft; edge: draft; safari: draft") stays the hint's sentence, no longer `value.outcome.status`. A draft or TestFlight upload no longer rewrites a store's review line: while the newest submission is an upload with no store answer of its own, the line answers the newest store answer on record (what the store reviewed or serves, with its state, source and date), and a pending line carrying no store state or source is not shown.
- A store submission is the release of that build for that browser (Cezar's decision A on the Rebeccat release report, 2026-10-28). `extension_release_status {include: ["history"]}` answers `value.storeReleases`, one row per store and version with `state` (`uploaded`, `in-review`, `live`, `rejected`, `withdrawn`, `superseded`), the store's own word in `storeWord` with `readAt` and `source` (`publish-answer`, `poll`, `run`, or `inferred` when the platform holds no store word, which grounds no next step), `visibility` (`public` or `unlisted`) only when the store said it, the stamped `storeVersion`, the build and the submission that advanced the row; its hint leads with what is live in each store, and `value.summary.activeReleases` now counts those live rows while the new `value.summary.liveChannels` counts the channels every browser's promote run proved live. `{include: ["stores"]}` carries each store's newest row as `release` beside its submissions, and names it in the hint. A platform that could not read the rows answers `storeReleasesUnread: true` and says the stores are unknown, not empty.
- `extension_submit` no longer takes or sends a `channel`. The label every submission carried (`channel: "stable"` by default) named no channel and changed nothing uploaded; the platform now records the channel whose pin for that browser is the build submitted, or none, and a submit's `value.channel` echoes only what the platform found. The approval of a submit binds `browsers` and `buildSha` alone, and the dry run no longer warns about a defaulted channel or reads channels.json. A platform older than 2026-10-28 refuses this server's submit approval as `APPROVAL_SCOPE_MISMATCH`, so the www deploy goes first; a platform at or after it still consumes an approval this server's 10.18 minted with the label, for one minor.
- `extension_submit` tells the agent what Edge Add-ons does while a submission is in certification review. The platform's Edge preflight now answers `edgePreflight`: every rule from Microsoft's own pages as a check `{id, severity blocking or warn, lock?}` (compressed files and the manifest inside the package, the version against the one the store serves, the first submission in Partner Center, a draft with nothing new, and what Partner Center's listing pages flag), the review in flight, and `edgePreflight.approval`, the sentence the approval shows naming what the act does to what is in flight. The tool's description says that a publish while Partner Center is still reviewing an earlier submission answers `InProgressSubmission` from the Publish API, so a publish the preflight reads as locked is queued behind that review, never failed, and never cancels it, and that an Edge upload during a review replaces the draft package only (Cezar's decision C of 2026-10-28, after Rebeccat spent four Edge approvals on publishes the store could not take).
- A real `extension_submit` that names several stores asks for one approval per version across stores (`extension_submit.version`, scope `{buildSha, version, acts: ["<store>:upload", ...]}`) instead of one approval per store: the approval-required answer carries `value.lines`, one row per store with the sentence the owner reads, and the approval page lets the owner uncheck a store before approving once. The call resumed with that `approvalId` runs each store's line and answers `value.lines` with each store's state (`spent`, `refunded`, `denied`, `consumed`, `revoked`, `not-in-approval`, `unspent`); a store the owner left out is reported as left out, never as missing, and a refused dispatch that gave a line back keeps the `approvalId` for a retry naming only the stores that did not run. A single-store submit keeps the single approval. The approval reads (`approval-required`, `approval-pending`, `extension_approvals` status) carry `value.lines` with each line's state when the platform answers them, and a platform refusal that names stores which cannot run (`value.stores`) is answered before any approval is asked.
- `extension_submit` `action: "publish"` takes several stores (chrome, edge, safari) with `buildSha`: one approval per version with a `<store>:publish` line per store, then each store's draft is sent on its own route, and the answer reports per store whether it was sent (line `spent`), queued behind a review in progress (`publish-queued`, line `queued` and still pending until the queue sends it), refused, or given back. A single store keeps the single publish approval.
- `extension_submit` `action: "sync-listing"` over several stores whose listings the platform asks an owner for gathers them into one approval: a `<store>:sync-listing` line per store, bound to that store's listing digest, so the call resumed with that `approvalId` and the same browsers writes each listing once; a store the owner left out answers `left-out` without failing the others, and a store that asked for nothing is written as before. An approval id this server minted for one store is still refused for several.
- `extension_submit` `action: "preflight"` keeps a locked check's lock: a check the store holds behind a review in progress answers `status: "locked"` with `lock: {kind, clearsWhen, storeWord, readAt}` under `value.stores.<store>.locked`, never under `failing`, and each store's preflight block answers as `value.storePreflight.<store>: {act, blocking, warnings, lock, approval}`, with the hint naming what each lock waits for. The approval page's lines carry the same lock, so the owner reads what a publish is queued behind before approving.
- The engine pin moves from Extension.js 4.1.33 to 4.1.36 (`extension-create`, `extension-develop`, `extension-install`). A project without its own Extension.js now runs 4.1.36, which waits for the extension to connect before it prints ready, refuses a production build into the folder a running dev session serves, flags loopback origins in a production manifest and clipped Edge embedded options pages, and accepts `build --out-dir`.
- `extension_build` answers the engine's refusal to write over a live dev session as itself. Extension.js 4.1.36 stops a build whose output folder is the one a running `extension dev` serves and writes nothing; the tool used to report that as `E_BUILD_FAILED` with a hint about compile errors. It now answers `E_DEV_SESSION_DIST_SHARED` (status `build-refused`) with the engine's message, `value.livePids` naming the sessions this server knows of on that project and browser, and a hint to call `extension_stop` and build again. An older engine still writes over the session's dist, and the warning that says so is unchanged.
- `server.json` carries the version `package.json` ships, and the suite fails when the two differ. Releases 10.15.0 to 10.18.1 were bumped by hand and left it at 10.14.1, which kept the MCP registry listing at 10.14.1. The registry checks (the nightly `registry-listing` job and the release's read back) ask the registry for the latest entry only, so the answer no longer depends on which page of versions it lands on, and the `Publish MCP registry listing` workflow takes a `version` to list a release npm serves from its own tag.

- New platform tool `extension_approvals`: action `status` reads where one approval stands, and action `revoke` takes back a pending approval, or one approved and not used yet, so no act can ever run with it (2026-10-28: an owner approved a Safari App Review submission of a withdrawn build by accident and could only wait out its twelve hours). Only a token a workspace owner minted may revoke; an approval that already ran is refused with what it ran, and nothing changes. The answer reads the approval back and reports `value.outcome` and the approval page in `value.links`. Every act that presents a revoked approval is refused before it calls the platform with `approval-revoked` (`ApprovalRevoked`), naming who revoked it and when, and a platform refusal `APPROVAL_REVOKED` answers the same status. The server now lists 36 tools, 12 of them platform tools.
- `extension_submit action:"cancel" store:"safari"` removes the App Store version from Apple's App Review. The platform (www and registry-template 2e5f964) now carries the act: it is refused before any approval when the record says nothing is in review, the approval reads "This removes Safari <version> (build <n>) from App Review" with the state App Review last recorded and its date, and the run cancels the open review submission (`PATCH /v1/reviewSubmissions/{id}` with `canceled: true`) and records the version's state Apple reads afterwards. The answer is `canceled` once the record reads draft, with Apple's state (`DEVELOPER_REJECTED`) in `outcome.storeState`, and its hint says the build stays on TestFlight; `cancel-dispatched` until then. `CANCEL_STORE_NOT_SUPPORTED` now names Firefox and Edge only.
- `extension_submit action:"publish"` names the store of the call in its draft refusals: a Safari submission that is not a draft answers "Only a Safari draft can be sent to review" (it said Chrome for every store), Edge reads "an Edge draft", and the no-draft hint names the store and its `browsers` value. Two Safari refusals the platform now makes before any approval are answered with their fields: `SAFARI_NEWER_BUILD` (a newer TestFlight build is a draft, so the older one is not sent) and `SAFARI_NEWER_BUILD_UNREAD` (a newer build's run failed after its upload and the platform asked the store poller to read it back from App Store Connect), each with `value.newerSubmissionId` and `value.newerBuildNumber`. A Safari `cancel` answers Apple's version state and the review submission's state each as what it is (`value.versionState`, `value.reviewSubmissionState`), so the review submission's `COMPLETE` is never said to be the version's.
- `extension_submit action:"preflight"` answers compactly by default. Each store's `requirements.items` and `bringList.rows` list only the rows not on file (a missing row whole, with its format, how and docs; an unknown row by its id, status and dashboard tab) and count the rest in `onFile`; the failing and warning checks, the summary, the connection and the STORE.md advisory are unchanged, and `value.detail` says how to ask for more. The new `detail` input takes `true` for every row in full, or a list of stores and requirement ids (`["chrome", "safari.subtitle"]`) for only those. A four-store preflight of the Rebeccat walk's size fell from 96,272 characters, over the client's tool-result limit, to about 16,600.
- `extension_submit action:"sync-listing"` takes each store's icon from the completed platform build of the checked out commit even while the platform's build list still shows that build running. The list keeps a run's status for minutes after it concluded (it read `status: "building"` beside `conclusion: "success"`), so a sync right after a build silently fell back to the local dist; the commit's own build record (`builds/<sha>`) is now read whenever the list does not show it completed. `value.iconSource` answers `{ from: "build", build }` or `{ from: "local", reason }`, and with a checked out commit `value.sayToPerson` names the stores whose icon came from the local project and why (the build still running per its own record, or never pushed).
- `extension_assert` gains `page-world-clean` with a `url`: whether a site the extension's content scripts match can tell the extension is installed. On a Chromium session it attaches to that open page and reads its main world, the page's own and never the extension's isolated world: every attribute value and text node (open shadow roots included) carrying the extension id or its `chrome-extension://<id>` base url, named by element and attribute; every symbol-keyed own property of `window` (a `Symbol.for('soccer-lens-media-hook')` left by a MAIN-world script) and every string-keyed one whose name or value names the extension; and each static `web_accessible_resources` entry (no `use_dynamic_url`), one concrete path resolved from the built dist, fetched from the page at its guessable url. Any of those fails the check with what leaked and where; a pass states the bytes scanned, the window properties compared and the resources probed, so it says what it looked at. Own window properties absent from an `about:blank` tab of the same browser and not in the clause's `pageGlobals` are a warning line, never a fail, since pages define their own globals. A page not open in the session, an unreadable manifest or an unresolved id is inconclusive with what would settle it; Firefox and Safari answer inconclusive with the hand read. Ledger 269.
- `page-world-clean` fails on a window symbol only when the extension can be blamed for it: a symbol-keyed own property of `window` whose description carries the extension id or its `chrome-extension://<id>` base url is a leak; any other symbol (YouTube's own `Symbol(google.goem)` failed the first live run) is a warning line, "unattributed symbols on window", with every symbol kept in `evidence.globals.symbols` and the blamed ones in `evidence.globals.attributedSymbols`. The baseline the page's own globals are compared against is now read inside the matched page, off a fresh hidden same-origin `about:blank` frame appended and removed by the read, so it is a secure context like the page and no page script ran in it; the background `about:blank` tab the check used to open is an opaque-origin non-secure context, which listed about 240 secure-context-only built-ins (`GPU*`, `cookieStore`, `caches`, `sharedStorage`) as unknown page globals. When a content script declares `match_about_blank` or `match_origin_as_fallback` the frame could carry the extension's own scripts, so the check falls back to the `about:blank` tab and says so in `evidence.globals.baselineNote`; the same fallback runs when the page does not answer the frame read. `pageGlobals` still exempts names from the warning. Ledger 272.
- `page-world-clean` on an `extension_dev` session no longer fails on Extension.js's own dev runtime. DOM attributes named `data-extjs-*`, the `extension-js-control.json` web-accessible resource the agent bridge adds, and any web-accessible resource the running manifest lists that the project's source `manifest.json` does not declare are labeled `devRuntime: true` in the evidence and left out of the verdict, and the detail (pass or fail) says how many were excluded and to run the check on an `extension_start` session for the shipped answer. The session kind is the ready contract's `command` (`evidence.session {kind, decidedBy}`); when the contract names none, the running manifest listing `extension-js-control.json` or a `data-extjs-*` marker in the page decides dev, and the detail names which signal did. On an `extension_start` session nothing is excluded, so a dev marker that shipped fails. Ledger 273.
- `extension_open` takes `foreground: true` with a `url` on Chromium, for a page the person must act on (a sign-in, a consent screen): the tab opens active (`Target.createTarget` with `background: false`), is made the active tab (`Target.activateTarget`) and its window is raised (`Page.bringToFront`). The answer carries `value.foreground {requested, activated, windowRaised, reason?}` and a hint saying the tab is waiting for the person, that the window was not raised, or, in a headless session, that no one can see it; a request the server cannot honor (Firefox, Safari, a page navigated in place by `tab`) answers `activated: false` with why. The default is unchanged: a url opens in a background tab and never takes the screen. Ledger 261.
- `extension_eval` over the debug port no longer answers a page frozen by a debugger pause as a generic `eval-timeout`. When an evaluate times out, the server attaches to the target and to the other pages of the browser, enables the debugger on each and reads the `Debugger.paused` the browser sends for a page already stopped; a page that is paused, or that another paused tab of its browsing group holds ("Debugger paused in another tab"), answers the new `page-paused` (`E_PAGE_PAUSED`) with `value.paused {targetId, url, samePage, pausedPages [{targetId, url, reason, at}], devtoolsOpen}`, a message naming the paused page and where it stopped, and a hint to press Resume (F8) in the DevTools that paused it or close that window. The server never resumes another debugger's pause itself. Ledger 264.
- A Chromium dev session whose extension loaded but whose background never connected to the dev server no longer stays silent. After 15 s unconnected, with the browser up and the extension listed on the debug port, `extension_wait` (and so `extension_dev`) reloads the extension once per session over the debug port (`chrome.runtime.reload` in its background, woken first when asleep) and watches the contract; a background that connects then answers `ready` with `value.executorRecovery` and a warning saying what this server did and that pages opened before still run the content script they loaded. A reload that does not bring it back leaves `compiled-not-attached` with `value.executorRecovery` and the fresh-profile relaunch. Every `compiled-not-attached` answer now carries `rebuildsReachBrowser: false` and says an edit compiles but does not reach the browser until the background connects, and `extension_wait {for: "rebuild"}` on such a session reloads over the debug port itself, answering `reload.outcome` `reattached` (`reloadKind: "debug-port"`) or the new `not-reached` with why, instead of waiting out a reload the dev server cannot apply. Ledger 257 (the Rebeccat walk of 2026-10-27, where a background cached in a reused profile connected only after the agent ran `chrome.runtime.reload()` by hand).
- `extension_screenshot` on Chromium captures the shown tab of a window that sits behind other windows. The browser does not paint that tab, so `Page.captureScreenshot` hung until `E_CAPTURE_TIMEOUT` and the only way out was bringing the window forward by hand. When the first capture does not answer within 4 s, the tool asks an extension background in the session to show a blank tab in that window (`chrome.tabs.create`, which never focuses the window), captures the page as a background tab, then shows the page again and closes the blank tab; it never sends `Page.bringToFront` or `Target.activateTarget` and never takes the keyboard. The answer carries `value.behindWindow` and a warning saying what happened, and a timeout says why the blank tab could not be shown. Ledger 260.
- `extension_eval` `context: "content"` with a `url` on a Chromium session evaluates over the debug port in the extension's isolated world of the matching tab, the world its content scripts share, instead of through the in-page executor's eval, which an MV3 extension's content_security_policy (the default included) refuses with `E_CSP_BLOCKS_EVAL`. The server attaches to the tab, reads `Runtime.executionContextCreated` and evaluates in the context whose `auxData.type` is `isolated`, whose origin is the extension's own `chrome-extension://<id>` and whose frame is the tab's top frame, so `chrome.runtime` and the globals and DOM the content script set are readable without loosening the extension's policy; variables a bundled content script keeps inside its module scope are not, and the hint says so. A tab where no content script of the extension has run yet, a session with no debug port, or a session without the eval token goes through the relay as before, and a CSP refusal there tells the agent to name a tab where the content script has run. Content evals without a `url` keep the relay.
- The descriptions of `extension_eval`, `extension_start` (and its `allowControl` flag) and `extension_wait` state the engine each feature needs ("Extension.js 4.1.34 or later") instead of calling 4.1.34 "not yet released", which stopped being true when 4.1.34 and 4.1.35 shipped; the `start` refusal for an engine without `--allow-control` names 4.1.34 the same way. The `compiled-not-attached` note no longer tells a project to "update Extension.js to read why": no Extension.js release writes an attach diagnosis into ready.json, so on 4.1.35 the advice pointed at an update that does not exist; the note now says the engine wrote no diagnosis, so the reason is not in the contract.

- A record read the platform does not answer no longer ends an act's wait. While `waitSeconds` remains, a read that times out (every platform read is bounded at 15 s), a refused connection, a DNS failure, a 429 or a 5xx is a miss the wait retries after `retryAfterSeconds` (5 s when the platform names none, never past the bound), so `extension_submit {browsers: ["firefox"], waitSeconds: 300}` whose first read of `/api/cli/stores/submissions` timed out now answers `submit-failed` with AMO's reason once the record reads failed, instead of `submit-dispatched` with `readProblem: "could not reach ...: the platform did not answer within 15 s"` at 15 s. Only a bound spent on such reads answers `<act>-dispatched` with `value.outcome.readProblem` naming the last miss and the count (`...; 5 reads of the record missed over 20 s`) and `readMisses`; a refused read (401, 403, 404) still ends the wait at once. The rule runs in the shared wait helper, so submit, publish, cancel, rollout, promote, the tester link, rebuild, recheck and the listing push's read-back all follow it, and the approval wait of 254 treats a poll the platform did not answer as a miss rather than a decision, naming the misses in `value.readProblem` when the bound passes.
- Store assets before the first submission (the board's plan Cezar adopted 2026-10-26, lane L4). `extension_submit action:"preflight"` answers, per store, `value.stores.<store>.bringList` (`readyForReview`, and one row per platform requirement with `supply` "from your build" or "you supply", the store's own format and documentation link, `clearedBy` naming the exact door that clears it, `decideOnce` on the rows a store never lets you change and `neverPrefilled` on every privacy or data answer) plus `value.stores.<store>.readyForReview`, and `sayToPerson` reads the list after the missing inputs; the rows stay the platform's, passed through whole. `extension_screenshot` takes `forStore` (chrome, firefox, edge or safari): the capture is one of that store's accepted sizes (1280x800 unless width and height name another the store takes) at a 1x pixel ratio, flattened on this machine to a 24-bit PNG with no alpha channel, and `value.forStore` says whether the file clears that store's screenshot row and why not when it does not; one 1280x800 capture clears all four stores. `sync-listing` `screenshots` stays the one door into the per-store listing record and the answer carries `value.stores.<store>.images` (`clears`, the image rows the platform now reads have; `remain`, those still open with their format), read back from the platform after the write. STORE.md carries no screenshot: the `- Screenshots:` line is no longer read for files (it is named in `skipped` with the door), the generated field table lists no screenshots line, and the requirements overlay never marks a screenshots row have from STORE.md. A review send the platform refuses with `409 LISTING_INCOMPLETE` (the www publish and submissions routes, before any approval is minted or consumed) answers `listing-incomplete` on publish and on submit with `value.missing` (the rows in the store's words), `value.bringList`, the store's console page in `trackUrl`, `nextStep` `screenshot` or `sync-listing`, and says nothing was sent, no approval was spent and no submission was recorded; the body is read against the typed stub `{ code: "LISTING_INCOMPLETE", message, rows }` (`src/lib/store-listing-incomplete.ts`, `rows` the per-store requirement rows the console reads too) until the platform's shape is pinned.
- `extension_submit action:"sync-listing"` reads each store's 128 px icon from the build the store receives: the completed platform build of the commit `projectPath` has checked out (its git HEAD), or the build the new `useBuild` sha names, whose package comes through the platform's artifact relay under the login's own token (the store's own package, else the Chrome package) and whose manifest names the icon read out of the archive. It used to take whatever `dist/<browser>` held, so a stale local build kept the old icon on three stores while the platform build and the source carried the new one (ledger 255, the Rebeccat walk of 2026-10-26). With no platform build of that commit it falls back to the local read, which now compares the dist icon with the icon the source manifest names: equal bytes are sent as dist, no dist sends the source icon, and a dist older than the source is withheld with `iconMissing` reading `dist/<browser> is older than <source icon>; run a build or pass useBuild: "<newest build>" to take the icon from build <newest build>`, the store answering `icon-stale` rather than `unchanged`, the sentence in `sayToPerson`. Every store's row names where its icon came from in `value.stores.<store>.icon` (`{ from: "build", build, file }`, `{ from: "dist", file }` or `{ from: "source", file }`), and a build whose package could not be read says so and sends the local icon only when it is current.
- A platform call that names no `project` no longer answers for whichever login was stored last. Given `projectPath` (`extension_submit`, `extension_shares`, `extension_preview_web share:true`), the call uses the stored login of the project that directory names: `<origin owner>/<package.json name>` or `<origin owner>/<GitHub repo>`, then the one login whose project slug is either, following a rename alias; the answer says so in `value.note` when this server's default login is another project. A directory whose project has no stored login answers `project-mismatch` (`E_PROJECT_AMBIGUOUS`) with both names, the default login it did not use and the `extension_auth` login to run, and sends nothing. With several logins on the server, no `project`, no `projectPath` and no login made through this server, the call answers `project-ambiguous` with `value.logins` and sends nothing; one stored login, a pin, `EXTENSION_DEV_TOKEN`, a hosted connection or an approval's own login still settle it as before. An unnamed read no longer makes the newest of several logins this server's default. Every answer of a project-scoped platform call now leads its `value` with `answeredFor`, the `<workspace>/<project>` it was made for. Ledger 252 (the Rebeccat walk whose preflight of the rebeccat directory scored leon's stores after a reconnect).
- A call that carries `approvalId` and `waitSeconds` and meets an approval nobody has decided yet waits for it inside the call: it polls the approval every `retryAfterSeconds` up to the bound, and once a person approves it runs the act and the record wait in the same call with what is left of the bound, answering e.g. `submitted` with `value.approvalWaitedSeconds`; a declined or expired approval answers its own refusal at once, and only a bound that passes answers `approval-pending`, saying how long it waited. It covers every platform act that takes `approvalId` and `waitSeconds`; a call with no `waitSeconds` answers at once as before. The `extension_submit` dry run no longer warns that the default `stable` channel "does not exist ... has no promoted build to serve": the build sent is always `buildSha`, and the channel only labels the store records, so a missing channel is mentioned only when one is passed by hand, saying the named build is still the one sent. Ledger 254.
- `extension_submit` answers whose store account a project uses: `value.stores.<store>.connection.source` is `"workspace"` when the project publishes with its workspace's account (Cezar's 2026-10-24 ruling: a store account is saved once per workspace and each project adds only its own listing ids) and `"project"` when the project connected its own, read from the platform's `connection.source` (or its `connectionSource`) and left out when the platform names neither. A failing check on a workspace's Chrome Web Store account says so: "The workspace's Chrome Web Store account failed its last check: <reason>. A workspace owner reconnects it once in the workspace's Store accounts settings, and every project that uses it is covered again.", in place of "Your Chrome Web Store connection failed its last check".
- Store accounts are read once per workspace (Cezar's ruling, 2026-10-24): AMO, Partner Center and App Store Connect keys are connected on the workspace's Store accounts page, and every project without its own key uses them. The preflight answers each store's `connectionSource` (`project` or `workspace`) and `connection.source`, and a ready store covered by the workspace says "<store> uses the workspace's account (<account>)." instead of a connect step; a workspace Firefox pair that AMO refused or never checked answers `store-connection-failed` or `store-connection-unverified` with `nextStep.kind` `configure` at the workspace's Store accounts page (`value.workspaceStoreAccountsUrl`), never a per-project connect form. `extension_submit action:"configure-store"` reads the store config after a write and answers `value.connection` (`source`, `connectedAs`, `healthy`) with the same sentence, and its credentials refusal names the workspace's Store accounts page first, keeping the project's connect form for a different account. `extension_workspace include: ["storeAccounts"]` lists the workspace's accounts (store, connected, connectedAs, connectedAt, checkedAt, healthy, never a key) with the Store accounts page.
- `extension_submit` `sync-listing` sends the App Store title as the app record's name: `- App Store name:` when STORE.md has one, else the record's name the platform's credential test read for the saved bundle id (`stores/config` `safari.appRecord`), else `- Name:` only when it is 30 characters or fewer. A longer Name is left out of the Safari listing with its length and the limit in `skipped` and `unread`, never pushed (the Leon walk pushed its 33-character Name, which also differed from the record's "Leon: Blur Faces"). A sync written with no approval now says why in one sentence: it was a plain act under the owner's own token (ruling 143), and only a value the platform derives takes a workspace owner's approval. Ledger 160.
- `extension_manifest_validate` and the `extension_build` gate read how a call to an API the target does not grant is written, by the same rule as the engine's `webkitGuardedRanges`. A guarded use (`chrome.downloads?.download(...)`, a call inside `if (chrome.downloads)`, `typeof chrome.downloads !== "undefined"` or `'downloads' in chrome`) is a warning naming the file and line ("guarded: runs only where chrome.downloads exists"), so a Safari build of a project that grants `downloads` only under `chrome:permissions` and guards its call no longer stops on `E_MANIFEST_BLOCKING`. An unguarded call still blocks, now with its file and line, and the message names the guard forms instead of suggesting `skipValidation`.
- `extension_submit` no longer says a submission is recorded before the platform's record says so. While `outcome.recorded` is false, `value.nextStep` is `watch` at the submission's console page and it and `value.sayToPerson` say the submission is dispatched and the record confirms when the run finishes, with `extension_release_status` to read it; on 2026-10-24 an Edge submit answered "uploaded to Edge Add-ons as a draft, recorded as uploaded" with `outcome.recorded: false` while the run had failed. When the record reads `uploaded` with a failed step (the store took the package and a later step of the run failed), the step is `watch` too and names the step, says the draft is not public and not in review, and says not to submit the same build again. A record that reads `draft` keeps the draft sentence. `value.nextStep.kind` gains `watch`.
- `extension_builds action:"configure"` answers the build settings the platform stored, not the ones it sent: enabling a browser whose install command, build command and output directory are empty now stores the project's own pattern (the install command another enabled browser uses, its build command and output directory with the browser name swapped, or `npm install`, the build script with `--browser <b>` and `dist/<b>` when no other browser is enabled), `value.changes` marks each filled field `(defaulted)`, `value.defaulted` names them, and `value.notes.safari` says what a Safari platform build needs beyond those fields (a macOS runner with Xcode and the signing assets from the Signing group); an explicit value always wins (ledger 155, the Leon walk that stored three empty Safari settings).
- `extension_submit action:"configure-store" store:"safari"` takes `bundleId` (reverse-DNS with two or more labels) and `appStoreId` (the app record's 6 to 15 digit Apple ID) as plain owner-token writes, and the refusal sentence no longer calls the bundle id console-only. The Safari preflight offers the exact `configure-store` call when the platform read the bundle id from the repository's `extension.config.js` and none is saved, names `extension_workspace action:"configure-project" supportUrl` and the new STORE.md `- Support URL:` line (sent with the Safari listing, hashed after `reviewContactPhone`) when the App Store support URL is missing, and requirement rows carry the platform's `value` (ledgers 155 and 159).
- STORE.md takes `- App Store name:` under `## Safari` (also read from `## Listing`), the name the App Store app record keeps, up to Apple's 30 characters. App Store names are global, so the record's name can differ from the listing's `- Name:`: the Leon walk's "leon" was refused as taken and its 33-character Name is over the limit. `extension_submit` `sync-listing` sends it to the App Store listing as `appStoreName`, hashed right after `title` as the platform hashes it, and leaves a longer one out with its length in `unread`; the preflight's `safari.name` item reads it first, then a `- Name:` of 30 characters or fewer, else missing with the limit, and is satisfied by `store-md: App Store name`. The generated field table lists the line. Ledger 158.
- STORE.md single-value lines are read up to a trailing parenthetical that names a store, and the note is read too: `- Category: Productivity (Chrome: Productivity, Safari: Utilities)` yields `Productivity` for every store and `Utilities` for the App Store, and the same `(Store: value)` note on `- Name:`, `- Subtitle:`, `- Summary:`, `- License:`, `- Support email:`, `- Homepage:` and the review contact lines gives that store its own value in place of the text before the note. A line of several categories keeps reading a plain `(Chrome Web Store)` note as the stores that category is for, and a note that names no store is a remark, kept out of the license, support email and homepage as before and left in the prose lines, since this server copies the owner's words and never rewrites them. The field table carries the rule. Ledger 136 addendum.
- `extension_submit action:"sync-listing"` answers, per store, the STORE.md lines it looked for and did not find: `value.stores.<store>.unread` is a list of `{ field, line, section }` rows (for example `{ field: "categories", line: "- Category:", section: "## Listing" }`), in the order the store's listing takes them, with `- Screenshots:` when neither STORE.md nor the `screenshots` argument carried a file. The preflight's `storeMd.notCovered` lines and the reconciled check messages say the same thing in words, `STORE.md has no \`- Category:\` under \`## Listing\`` in place of "not in STORE.md", naming the section the field table gives the line. A line that is present but could not be read stays in `skipped` with its reason and is not repeated in `unread`. Ledger 136 addendum.
- `claude/reference/store-md-fields.md` and `docs/store-md-fields.json` list every STORE.md line `extension_submit` `preflight` and `sync-listing` read, per store, with the section each belongs to (`## Listing`, `## Privacy and data use`, or the store's own section such as `## Chrome Web Store`), the other sections it is also read from, and its limit. Both files are generated by `pnpm docs:tools` from the parser's own declarations (`STORE_FIELDS`, `BULLET_KEYS`, `SUBSECTION_KEYS`, the section names and the limits in `src/lib/store-md-declarations.ts`, the lists the parser matches against), a test fails when they drift, and the line column is the label the platform's requirements name in `satisfiedBy: "store-md: <line>"`, so the preflight's `requirements` overlay and the sync read one table. `- Privacy policy URL:` is now also read under `## Listing` or a store section, where the template's header once put it; `## Privacy and data use` stays its home and wins when both carry one. Ledger 136 addendum.
- A platform tool on a server that knows it was rebuilt reloads the new build instead of refusing. The server imports the rebuilt `dist/module.js` under a stamped specifier, hands it the server options and the kept default login, and answers from the new build's own dispatcher while the transport and the session stay open; the first answer after each reload carries the warning `This server reloaded its code from the <time> build before answering.` once. `E_SERVER_STALE` (status `server-stale`) remains only when that reload fails, with `value.reloadError` saying why (no loader, an import error, a build without the reload contract) and the `/mcp` sentence as the last resort. Local tools keep the code they loaded, since their dev sessions live in the process's memory, and warn once per rebuild that `/mcp` picks up their new code. `dist/module.js` is now one file with no shared chunk or runtime file beside it, and `EXTENSION_MCP_DIST_ROOT` lets a rebuild write to another directory and rename it into place so a running server never imports a half-written build (ledger 248, the Rebeccat walk that met five rebuilds in five hours and stopped at each one).
- `extension_builds` `action: "download"` no longer writes inside the project or edits its `.gitignore`. The default destination is the user's cache directory, `<cache>/extension-dev/artifacts/<workspace>/<project>/<sha>/<browser>.zip`, where `<cache>` is `$XDG_CACHE_HOME` when set, `~/Library/Caches` on macOS, `~/.cache` elsewhere, and `%LOCALAPPDATA%/extension-dev/Cache` on Windows, resolved the way the server resolves its config directory from `XDG_CONFIG_HOME`; `projectPath` is now optional and only anchors a relative `to`, an explicit `to` still writes exactly there, the answer's `path` is always absolute, the `gitignored` field is gone, and `sayToPerson` names the path and says the project's files and `.gitignore` were not touched. A project with no `.gitignore`, or a read-only one, downloads the same way. Ledger 249 (the Rebeccat walk where a read-only "save the package" ask left ` M .gitignore` in the repository).
- `extension_submit` renders the platform's `409 EDGE_PACKAGE_HAS_ARCHIVES` as `package-refused`: Partner Center refuses any archive inside an extension package ("The uploaded package consists of a compressed file"), and the platform now scans the build's `edge.zip` for `.zip .gz .tgz .tar .br .bz2 .xz .7z .rar .jar .crx .xpi` entries and gzip bytes under any name before any approval or dispatch. The answer carries `value.files` (the nested archives by path), `value.store`, the build page in `value.trackUrl`, and `sayToPerson` naming the files with the Tesseract hint (ship `.traineddata` uncompressed; Tesseract.js takes `gzip: false`); `nextStep` is `resubmit` at the build page, and no approval is spent. UI ledger: the Rebeccat owner learned the rule from Partner Center after creating the product, with an `edge.zip` the platform had hashed and called ok.
- `extension_wait` and `extension_dev` answer the engine's own diagnosis of a browser that is up with nothing attached, as soon as ready.json carries it, instead of a generic `compiled-not-attached` after the whole budget. Extension.js (ledger 1057, branch `fix/1057-ready-after-attach`) stamps `browserUpNotAttachedAt`, `browserUpNotAttachedWaitMs` and `browserUpNotAttachedHint` on the contract 15 s into a live browser with no attach, plus `profileReused` at launch, and clears the three on the first attach; this server's contract type carries the four fields. When the stamp is there, `extension_wait` returns on that poll (no further budget spent) with `status: "compiled-not-attached"`, `value.browserUpNotAttachedHint` (the engine's sentence verbatim), `value.profilePath`, `value.profileReused`, `value.browserPid`, `value.waitedMs`, `value.sayToPerson` leading with the hint and the one-line way out, and `value.nextStep` calling `extension_dev` with `replace: true` and a fresh `profile` beside the one in use (`<profile>-fresh-<yyyymmddhhmm>`, or a `fresh-<stamp>` directory under the managed profile root when the contract names none); `extension_dev` relays the same answer under the same status with the fields hoisted to `value`. A contract without the fields (an older engine) answers as before, and the generic message gains "the engine running here reports no attach diagnosis; update Extension.js to read why" for every browser but Safari, whose not-enabled cause is already named. The first attach clearing the fields turns the same wait into `ready`. Ledger 247 (the Rebeccat walk that lost 45 s on a reused `dist/extension-profile-chrome` with no cause shown); needs the engine of 1057 in the project.
- `extension_stop all: true` no longer ends another project's session unannounced. With no `projectPath`, a call whose sessions span more than one project answers `ok: false, status: "confirm-required"` with `value.wouldStop` (every session it would end, grouped by project: `[{projectPath, sessions: [{browser, pid, mode}]}]`), `value.foreign` (sessions another running MCP server owns, which it never touches), `value.sayToPerson` ("This would stop N sessions across M projects: <list>. Say stop again with confirm: true to end them all, or name projectPath to stop one project.") and `value.trackUrl`, and stops nothing; the same call with the new `confirm: true` input ends them and answers `stopped-all` as before. `projectPath` beside `all: true` scopes the stop to that project's sessions and carrier with no confirmation, and sessions that all belong to one project stop with no confirmation either. Every `extension_stop` answer now carries `value.trackUrl` (ledger 246, the Rebeccat walk where `all: true` ended Leon's Firefox session with no word beforehand).
- `extension_submit` `action: "sync-listing"` names every listing value the platform did not copy verbatim from STORE.md. The platform marks such a change entry `derived: true` with the field it came from (today one case: the App Store subtitle the Safari push copies from the Summary when STORE.md has no `- Subtitle:` line and the Summary is 30 characters or fewer), its approval page lists it as "Subtitle (derived from Summary)", and a sync whose changes carry a derived value takes the approve page through the new policy row `extension_store.listing-derived` (approval; held on both sides), while a listing made only of the owner's own lines stays plain. This server passes the platform's `changes` entries through, answers `value.stores.<store>.derived` ({field, from, line}) when any is marked, and says in `sayToPerson` which value was derived and which STORE.md line replaces it ("add `- Subtitle:` under `## Listing` in STORE.md to write your own"); the approval request's reason names the derivation when the local read predicts it. The preflight's `safari.subtitle` item reads "missing (optional), add `- Subtitle:` under `## Listing`" when absent and is satisfied by `store-md: Subtitle`, so a `- Subtitle:` line in STORE.md answers `have`. Nothing here writes a subtitle, and no answer names a run or a mirror.
- `extension_auth action:"status"` honors `project` like every token-scoped tool: `project: "cezaraugusto/leon"` reports leon's login (slug, `projectId`, api, expiry) and asks the platform's whoami with leon's own token, so the verdict is about that token and not the default's; with no `project` it still reports the default login and lists every stored login under `value.logins` with its `active` flag, and a `project` with no stored login answers `not-signed-in` for that project with the login call, without reaching the platform (ledger 154, the leon walk where the status answered rebeccat's slug and expiry).
- A retry that carries an `approvalId` is made with the login that requested the approval. The approval record beside the login store (`approvals.json`) now carries `loginId`, the token's own id from its claims (a sha256 fingerprint when the claims carry none; never the token value), and a call with an `approvalId` this machine minted resolves its bearer from that record first: the stored login with that id, else a stored login for the record's `prj_` id, else the one under the record's slug, whatever login became active in the shared store since and whichever process answers, so a server rebuild between the request and the retry changes nothing. When none of those is stored the call answers `auth-required` with `ApprovalLoginGone` ("the login that requested this approval is no longer stored; sign in to <project> again and request a new approval") and the console page in `trackUrl`, before any platform call; a different project is still `ApprovalOtherProject`. A 401 from the platform is now answered as the login's refusal, never the approval's: on the request, `LoginRefused` ("The platform did not recognize the login this call used for <project> (401): <reason>. No approval was requested and nothing was executed.") mints nothing; on the confirmation, `ApprovalLoginRefused` says the approval itself was not consulted and keeps the `approvalId` for the next call, instead of "request a fresh approval by calling with no approvalId". Ledger 153: the Edge submit confirmation of 2026-10-24 01:18Z was refused with 401 "Unrecognized release token" while the platform's token-record read was out of GitHub budget (six `TOKEN_NOT_TRACKED` whoami refusals in the same three minutes); the approval was valid and the leon login was stored and bound.
- `extension_submit action:"preflight"` reads `value.stores.<store>.requirements` against the project's STORE.md with the same parser sync-listing uses: an input the platform calls missing that STORE.md already carries answers `have` with `satisfiedBy: "store-md: - <line>:"` (or the `### heading`), and the missing-inputs sentence counts only what is missing. The `- Screenshots:` line is read in both forms, bare and `- Screenshots (1280x800, in this order):`, with the files listed one per line below it; sync-listing uploads those files when no `screenshots` argument is given, and a line the reader cannot take is named, with the shape it wants, in the item's `actual` and in `storeMd.notCovered`. The App Store items carry the platform's `push` state (`not pushed yet`, `queued`, `running`, `failed`, `landed`) as a field of their own, never as a reason for `missing`. STORE.md's Safari section now also fills `- Review contact name:`, `- Review contact email:` and `### Reviewer notes` on the listing beside the phone.
- `extension_builds` `action: "download"` saves a build's package to disk from the platform: `buildId` and `browser` (chrome, edge, firefox, safari, or `source` for the source archive a public project's build uploaded), written to the directory `to` names or, by default, under the user's cache directory (see the entry above; the first cut wrote it to `.extension.dev/artifacts/<sha>/` inside the project). The bytes come through the platform's own artifact relay under the stored login's token, never from the registry address the record names, which answers 401 to a project token (ledger 152) and sent the Leon walk to a local rebuild that was not the package the integrity report describes. The answer carries `path`, `bytes`, `sha256`, `verified` (true when the file matches the sha256 the build's integrity report records, read from the platform; `"no-report"` when no record names one, with the relay's digest header standing in for the source archive) and the build page in `trackUrl`, and says "Saved the platform's <browser> package for build <sha> at <path>, byte-identical to what the integrity report describes"; a mismatch answers `integrity-mismatch` with both digests, leaves the file for inspection and says not to upload it. `action: "get"` keeps every `artifacts[].downloadUrl` and adds `download: { action, buildId, browser }` to each package row so an agent finds the call; the Edge requirements item for the Partner Center product now names it for the first package uploaded by hand.
- `extension_submit` `action: "publish"` answers `status: "upload-running"` instead of a refusal when the platform holds the publish because the submit run carrying the package is still queued or running: `value.uploadRunState`, `value.buildId` and `value.submissionId` name the upload, `value.sayToPerson` reads "The upload for build <sha> is still running; say publish again when the status reads landed.", `value.nextStep` is publish, and `value.trackUrl` is the store's submissions page; no approval is requested. Once the upload has landed the platform publishes a Chrome draft that carries no store submission id (the normal shape of a fresh draft-until-public upload, since the store assigns the id when `items.publish` runs) and the dispatch answers as before; until www 5cd25e6c9 that draft was refused with SUBMISSION_NOT_JOINABLE on every try, closing the only platform path from draft to review (rebeccat 2026-10-23, three tries over eight minutes). A refusal with that code and no upload run named still answers `publish-refused`.
- A platform tool on a server that knows it was rebuilt answers `ok: false, status: "server-stale", error.code: "E_SERVER_STALE"` at once, before any platform fetch: "This server was rebuilt at <time>; run /mcp and pick extension-dev, then call again.", with `value.server` and the console page in `value.trackUrl`. The rebuilt warning used to ride along only once the platform answer came back, which on ledger 148 was after the hang. A fresh server answers as before, and the local tools keep running the code they loaded.
- Every platform call is one bounded fetch (`src/lib/platform-fetch.ts`): a read gets 15 s, a write that dispatches 60 s, and nothing retries past the call's own timeout. An `E_NETWORK` answer now says which it hit (the platform did not answer within the bound, the connection was refused, or the host could not be resolved) and carries the console page it was about in `value.trackUrl`. The 385 s `extension_builds list` of ledger 148 was the Mac asleep for 388 s with the call in flight (pmset log, 14:15:35 to 14:22:03 -03); the 20 s abort timer ran on the lid wake before the socket could, so the answer was a timeout stamped with the whole nap.
- The project pin follows a move. When the platform answers `PROJECT_MOVED` (the body carries `projectId`, `workspaceSlug`, `projectSlug` and `previousProjectSlug`, the current address beside the one that moved), this server rewrites the slug it recorded in `created-projects.json` and the `--project` pin when either named the project that moved, makes the call once more against the current slug, and the answer says once, in `warnings`, "<old> is now <new>; this server follows the new name." The refusal itself now carries `value.moved` ({from, to, projectId}); a move the retried call answers in turn is not followed, so two renames in one call cannot chase each other; a move that names a project this server never recorded or pinned rewrites nothing; a pinned server takes the new name on the pin check right after. The device login refused with `PROJECT_MOVED` follows the same records and says the same sentence. The login store's move now files under the server the call resolved (`EXTENSION_DEV_API_URL` included), where a call that passed no `api` used to look under production and miss (2026-10-23 rename audit).
- Approvals bind to the project by its `prj_` id, not by the slug the token carried, so a rename between the mint and the retry no longer reads as another project. The approval record beside the login store (`approvals.json`) now carries `projectId`, read from the stored login the minting token belongs to; a retry that names the new slug of the same id goes through and the answer carries `value.note` "The project was renamed from <old> to <new> since the approval was minted.", a retry for a project with another id (or one this machine has no id for) is still refused with `ApprovalOtherProject`, a fresh mint of the same act under the new slug replaces the old record, and the `ApprovalUnknown` sentence names the rename ("for <old> (now <new>)") instead of "this call resolved <new>" (2026-10-23 rename audit; Cezar ordered that a rename must break nothing).
- `extension_submit` `action: "cancel"` answers what became of the withdrawal instead of "accepted" for ever. The platform now records every cancel dispatch beside the store record and resolves it against the run it started, so the answer carries `value.dispatch` as a state ({runState, failedStep, failedReason, refunded}; never a run id or a run page): `cancel-dispatched` while it is queued or running, `canceled` once the record moved, and `cancel-failed` (ok false, `CancelFailed`) when the run died at the store, with `sayToPerson` "The withdrawal failed at the store: <reason>. The approval was refunded. Say status to read the store's current state." (on 2026-10-23 a cancel answered "accepted" with a dispatch id, the run failed at Chrome with NOT_CANCELLABLE, and nothing on the platform held either fact while the approval was spent). A cancel of a review the store already ended answers `store-not-reviewing` with the state the platform read from the store (`value.state`, `value.checkedAt`, `value.visibility`) and asks for no approval, because the platform re-polls a review record older than a day before it mints one; a record the platform could not refresh answers `review-record-stale` with the poll it requested. The stores read carries the record the platform settled from the store (`rawStatus` `no-active-submission`, the review's `visibility` and `crxVersion`, the `cancel` block with the store's sentence). `action: "preflight"` names a Chrome review in progress but blocks the submit step only when the saved mode would send the upload to review: under draft-until-public a submit uploads a draft beside the review and enters none, so the step stays; and a record the store contradicts (no active submission, published, rejected) blocks nothing. Every one of these answers carries `trackUrl`.
- `extension_submit` `action: "sync-listing"` sends the listing once more with only the fields the platform hashes when the platform's fingerprint differs from this server's, instead of refusing the whole listing with `LISTING_DIGEST_MISMATCH`. The fields the platform cannot know are read from `digest.platform` on its refusal (production www 141b63b03 hashes the ten safari fields in this server's order and answers `digest: {platform, client, differ}` on every `LISTING_DIGEST_MISMATCH` refusal); the retry hashes exactly what it sends, so the approval, the write and the approval leg with an `approvalId` go through for the subset. The answer carries `value.stores.<store>.digest` (`client`, `platform`, `differ`), `value.stores.<store>.deferred` naming the fields left out, `filled` without them, and `value.sayToPerson` ("The platform does not take subtitle, searchTerms and reviewContactPhone yet (its build is behind this server); the other 3 fields are synced. Say sync-listing again after the platform updates."). A second mismatch is refused with the same `digest`, a `trackUrl`, and a sentence saying which side is behind (this server when `differ` holds only fields the platform does not hash, the platform otherwise); a refusal that names no `digest` is answered as is, with no retry and "The platform did not name the fields it hashes; update the platform or this server."; chrome, edge and firefox are never resent. Rebeccat walk, MCP ledger 150.
- `extension_builds` `action: "list"` and `action: "logs"` read a run the platform canceled as canceled, never failed. A build whose run was canceled because a newer commit of the same branch landed answers `status: "cancelled"` with `supersededBy` naming that commit's short sha (null when the platform canceled it with no newer run in sight) on its list row, and the logs answer carries `run.conclusion: "cancelled"` with `run.supersededBy` beside it while every browser the run never reached answers `status: "cancelled"` with "the run was canceled before this browser's job started" instead of "failed". Both answers say so in `value.sayToPerson` ("Build d8044e3 was canceled because 9081f4d landed; nothing is wrong with it.") and in the hint, and both now carry `value.trackUrl` (the builds page, the build page). Until now the row read `status: "failed"` with no browsers, the logs called every browser failed before its job started, and the platform's Activity counter counted the canceled run as a failure (rebeccat d8044e3, 2026-10-23); the platform's own list, build page, logs and activity counter answer the same canceled verdict (www).
- `extension_submit` `action: "preflight"` carries what each store asks for beside its checks. When the platform answers `requirements` for a store, `value.stores.<store>.requirements` lists every input the store demands in the store's own words (`id`, `label`, `required`, `format` with the exact sizes, counts, color mode and character limits, `status` have, missing or unknown, `satisfiedBy` naming the STORE.md line, the file, the saved store setting, the console or the store's own dashboard, `how`, and `actual` when the platform read a value), with `missingRequired` and `missingOptional` counts, and `value.sayToPerson` and the hint lead with the missing required inputs by name and format, one sentence per store (for example "The App Store asks for 2 required inputs the project does not have yet: macOS screenshots (1 to 10 macOS screenshots at exactly 1280x800, 1440x900, 2560x1600, 2880x1800 px, RGB with no alpha channel, showing the extension running in Safari); Primary category (...)"), before the readiness sentence. No artifact is generated or offered: the answer says early what to bring, so an owner no longer learns each ask from a failed check or a rejected upload. `configure-store`'s `store-configured` answer names, after the preflight step, how many required inputs the store still lacks when the platform answers them with the change.
- `extension_workspace set-environment` refuses a secret variable with the `E_CONSOLE_ONLY` code the other console-only refusals use.
- `extension_submit` `action: "sync-listing"` for Safari answers the App Store Connect push as a state the person can act on. `value.stores.safari.appStoreConnect` passes through the platform's `status` (dispatched, failed, unchanged, landed), `runState`, `failedStep`, `retryHint`, `fieldsWritten`, `checkedAt`, `owed` and `warnings` with the console submissions page in `trackUrl`, and never the run's URL, its id or the mirror's name; an older platform's `dispatched: true` or `false` reads as dispatched or failed. `value.sayToPerson` (also appended to the hint) reads the state: dispatched, queued or running say preflight in a minute; failed carries the platform's failed step and retry hint verbatim and says sync-listing again when the hint allows a resend, or the next step from the reason (connect the store, fix STORE.md, or sync-listing again) when there is none; landed names the fields written and when; and what App Store Connect still owes is named with the STORE.md line to add under the Safari section. When the platform answers unchanged and no push ever landed, the listing is sent once more with `force: true` and the second answer is the one given; a platform that does not take `force` yet (400, or unchanged again) keeps the first answer with "the platform cannot resend an unchanged listing yet" in `sayToPerson` and `resend: "refused"` on the state.
- The STORE.md reader behind `extension_submit` `action: "sync-listing"` takes `- Subtitle:` (30 characters, the App Store subtitle) and `- Search terms:` (the App Store keywords, 100 characters joined by commas) for Safari, so the two lines reach the safari listing write and a change to either answers changed; until now the safari field list left search terms out and had no subtitle, and a STORE.md that gained `- Search terms:` still answered unchanged. A subtitle over 30 characters, or search terms over 100 characters joined, is left out with the limit in the `skipped` line and the STORE.md line named in `unread`, the same as the other fields. A third Safari line, `- Review contact phone: +55 11 99999 9999` (the App Review contact phone, E.164 with the plus and country code, which App Store Connect refuses otherwise), parses into `reviewContactPhone` with spaces, dashes and parentheses dropped, and a number without the plus and country code is left out with the shape named. The three lines are read from `## Listing` or, for Safari alone, from the lines above the first `###` subsection of the `## Safari` section, where they override the shared ones.
- `extension_submit` `action: "configure-store"` takes the store's own listing id as a plain write under the owner's token, which until now was the one store field a token could not write (ledger 144, gap 7): `storeSettings.chromeItemId` (the 32-letter item id, or the item's dashboard address, parsed the way the console's own field parses it), `storeSettings.edgeProductId` (the Partner Center Product ID GUID) and `storeSettings.firefoxAddonGuid` (an add-on GUID only, `name@example.com` or `{uuid}`; an AMO slug or numeric id is refused with the ruling's words, since it does not identify the add-on to Mozilla's blocklist), each checked in the store's terms before anything is sent and hashed last in the settings digest. Publisher ids, store URLs, bundle ids and credentials stay in the console, and the credentials answer is unchanged. The platform lifts its token refusal for exactly those three keys (www). Ledger 142 addendum: the advertised `storeSettings` schema now carries every key with a one-line description, and a preflight on a store whose credentials are saved and whose "Store publishing" switch is off answers `nextStep.kind: "configure"` naming `configure-store` (`enabled: true`, and for Firefox the source archive in the same call) with the settings page, instead of sending a person to the console connect page, which stays for credentials only.
- `extension_submit` `action: "preflight"` on a Firefox store answers the AMO key pair's state the way it answers the Chrome connection, read from the platform's own connection record (the console connect's check or the mirror's health probe, whichever answered last); until now a pasted issuer and secret passed every check and the upload failed at AMO with 401 "Error decoding signature" after the owner's approval was spent (2026-10-23). A pair AMO refused answers `store-connection-failed` with AMO's own detail in the hint ("Your Firefox AMO connection failed its last check: ..."), the sentence that the issuer and secret do not match and both are re-copied from https://addons.mozilla.org/developers/addon/api/key/, the console connect page in `value.connectUrl` and `nextStep` `connect`; a pair no store has answered for answers `store-connection-unverified` with the same page and `nextStep` `connect`, saying the platform refuses the upload until the pair is checked (the listed channel) or that an upload can fail at AMO after the approval is spent (unlisted); `value.trackUrl` is the store settings page in both. `sayToPerson` leads with the state. A real submit whose Firefox connection failed its last check is refused before any approval with the same sentences, and the failed-check sentence now names the store it is about ("Your Firefox AMO connection", "Your Edge Add-ons connection") instead of the Chrome Web Store for every store. A store whose credentials are missing keeps the `store-not-connected` answer that names the two AMO values.
- A submit approval reads the way the platform describes it on every call, not only the first. The platform now describes `extension_submit` itself from the store's saved submission mode ("Upload build <sha> to App Store Connect as a TestFlight draft (no App Review)" for a Safari draft, "to the Chrome Web Store as a draft (not published, not in review)" for a Chrome draft, and a review or a publish only where the saved mode or the run's review intent sends the upload on), and this server records that sentence beside the minted approval, so a later call that finds the approval pending or already spent repeats the platform's sentence instead of this server's own "Submit build <sha> to safari for store review", which on 2026-10-23 promised a review that the saved draft mode never enters. An approval this machine did not mint keeps this server's sentence.
- `extension_workspace` `action: "set-visibility"` changes the login project's visibility from the chat (`visibility`: `private` or `public`), the one project field no tool wrote and every share on a private project had to infer: `private` is a plain call under the owner's own token, answered `visibility-set` with what the platform republished (the registry declaration, the meta, every channel's audience, the exposure index) and the console Visibility section in `value.trackUrl`; `public` opens every build page and channel link the project ever made to anyone, which Cezar's ruling of 2026-10-23 keeps on the approve page, so the first call answers `approval-required` and a second call with that `approvalId` applies it once. The policy table gains `extension_project.visibility` (plain) and `extension_project.visibility-public` (approval), the tool's annotations stop reading as read-only, and the platform's visibility route takes the PUT from an owner-minted token through the same table (www), where a member's token is `OWNER_REQUIRED` and a public flip without an approval id is `APPROVAL_REQUIRED`.
- `extension_builds` `action: "configure-channel"` changes an existing release channel from the chat (`channel`, with any of `audience`, `description`, `color`), which until now needed the console for every field and the Releases page for the audience: a description, a color and a private audience are one PATCH under the owner's own token, answered `channel-configured` with the channel as the platform recorded it and the server's own `changes` lines, the Releases page in `value.trackUrl`; `audience: "public"` opens the channel's downloads to anyone with the link, which Cezar's ruling of 2026-10-23 keeps on the approve page, so the first call answers `approval-required` with the approve page and a second call with that `approvalId` applies it once. The policy table gains `extension_builds.configure-channel` (plain, with the public audience exception the create already had) and `extension_builds.delete-channel` (console); `action: "delete-channel"` answers `console-only` with the console Channels page and sends nothing, and `create-channel` with a public audience now says to create it private and open it with `configure-channel`. The platform's channel route takes the PATCH from an owner-minted token through the same table (www), a member's token is `OWNER_REQUIRED`, and the delete stays a session's act.
- `extension_workspace` `action: "configure-project"` changes a project's general, deployment, GitHub and release settings from the chat, which until now needed the console for every one of them: `settings` takes `displayName`, `description`, `url`, `supportUrl`, `liveChannel`, `branch`, `rootDirectory`, `workspaceRoot`, `buildPullRequests`, `runWhatsNew`, `runExtensionExecutables`, `pullRequestComments`, `commitComments` and `autoCreateGitHubRelease`, by the platform's own names; only the fields that differ from the stored settings are written, each section as a plain call under the owner's own token (policy row `extension_settings.project`, plain, on both sides), and the answer lists the `changes` with `trackUrl` on the console project settings page. `liveChannel` naming a channel whose recorded audience is public resolves to the table's channel-audience row, so a workspace owner approves it on the approve page before anything in the call is written; a private live channel is plain. The slug is refused before anything is sent (the platform's `SLUG_NOT_WRITABLE_HERE`), and a token minted by a member answers `OWNER_REQUIRED`. `action: "settings"` now reads the deployment, GitHub and release settings beside the general and build ones, warning instead of failing when a platform in front of it does not answer one to a token yet. The tool is no longer annotated read-only.
- `extension_workspace` `include: ["environment"]` lists the project's environment variables by name, scope (`all`, `production`, `staging`), secret flag and updated time, never a value, and `action: "set-environment"` sets and removes plain variables (`variables`, `remove`) as one plain call under the owner's own token (policy row `extension_settings.environment`). A variable flagged `secret: true` is refused before any platform call with `secret-console-only` and the console environment page where a person types it; a variable the platform stores as a secret is refused by the platform (`CONSOLE_ONLY`) and answered under the same status; and no answer from either act carries a value.
- The approval line moves to Vercel's shape (Cezar's ruling of 2026-10-23 on ledger entry 143, which also closes 137 and 139): a reversible setting is a plain tool call under the owner's own token, with the MCP client's permission prompt as its only gate, and the platform's approve page stays for the acts that leave a mark outside extension.dev. One policy table keyed by act, `src/lib/approval-policy.ts`, holds the verdict (`plain`, `approval`, `console`) and the one approval helper asks it before anything is minted: a plain act never mints on its own, a console act never reaches the platform. Plain: `extension_builds configure` (browser build enable and disable, install, build and output settings), `extension_submit configure-store` (store enabled, submission mode, Firefox release channel and source archive), a private `create-channel`, `sync-listing`, `rebuild` and `recheck`; each answers the applied answer directly (`build-configured`, `store-configured`, `channel-created`, `listing-synced`, `rebuild-dispatched`) with `value.trackUrl` and the platform's `changes` lines, and says in the hint that no approval page was involved. Kept on the approve page: a real submit, publish and send to review, cancel, rollout, promote, a public channel audience, public share links, and a listed or public submission mode, which is an audience change computed from the write (`configure-store` with `submissionMode` listed or public, or `releaseChannel` listed, answers `approval-required` with the audience reason). Console only, unchanged: disconnecting a store, deleting a project, credentials of any kind. `create-channel` with `audience: "public"` answers `approval-required` before anything is sent, naming the console Releases page where a workspace owner or admin opens it. A platform that still asks for an approval of a plain act (an audience change it computed from the stored state) is honored with the fingerprint it named, and an `approvalId` presented for any act is verified first as before. `SETTINGS_WRITE_GATE` is gone with its matching constant on the platform; the policy spec enumerates every act with its ruled verdict so a changed row fails loudly.
- `extension_analyze` tells a development build from a production one before it judges it. `extension_dev` rewrites `dist/<browser>` with the development build, and the folder was read as `buildType: "production"`, so the dev runtime's `eval`, its content-script stubs and its sourcemaps were answered as store review risks of the extension. Now the engine's own record is read first: `extension-js-control.json` at the dist root, which the engine emits on every development compile and never into a production dist, and whose `buildType` field, should the engine write one, outranks every marker; with no engine word, the hot/ folder and hot-update chunks, `content_scripts/dev-stub-N.js`, `dev-css-N.js` and `dev-registry.json`, and the engine's companion folder read as a development build, while `.map` files alone never do, since a production build can ship its sourcemaps. A development build answers `buildType: "development"` with `buildTypeSource` (`engine` or `markers`) and `buildTypeMarkers`, `reviewRisks`, `reviewCoverage` and `storeReadiness` as `null` with no review warning and no sourcemap sentence, `value.note` and the hint saying the store checks are skipped for a development build and that `extension_build` produces the build to analyze, and `value.nextStep` `{tool: "extension_build", browser, say}`. `manifestByBrowser.browsers` lists only the browser names the engine builds into (chrome, chromium, edge, brave, opera, vivaldi, yandex, chromium-based, firefox, waterfox, librewolf, zen, floorp, gecko-based, safari, webkit-based); every other folder under `dist`, such as a project's `chrome-test-host` or `firefox-test-host` copy, is named under `manifestByBrowser.otherFolders` and its manifest is never read, and the engine's `dist/extension-js` session folder is in neither list.
- `extension_workspace` takes `include` (`team`, `members`, `tokens`, `apps`, `activity`), five read-only sections the console held and no tool answered, added to any action's answer with that section's console page: `team` is the login project's members (login, role, joinedAt) and pending invites (id, masked email, role, invitedBy, createdAt, expiresAt), read from the project's team routes; `members` is the workspace's members and pending invites, read from the workspace's members routes with an owner-minted login; `tokens` is the project's access tokens (id, label, kind, createdAt, expiresAt, notAfter, issuedBy, build, revoked, revokedAt, revokedBy; never a value, and `lastUsedAt` null with a note that the platform does not record a token's last use); `apps` is the connected apps holding a live grant (name, redirect host, connectedBy, projects, connectedAt, lastRefreshedAt, expiresAt); `activity` is the 50 newest activity entries (category, event, status, time and the commit, message, branch, version, channel, browser, store, build, browsers and actor of each), copied by name so an entry never names a mirror repository, a workflow run or a commit author's email, and never says which source it came from. A section the platform did not answer is named in a warning with its console page, the others still answer, a section name outside the five answers `bad-request` before anything is read, and every change to any of them stays in the console. The call tracks on the first included section's console page (team, access tokens, connected apps, activity, or the workspace's members page).
- `extension_shares` lists and revokes the build links `extension_publish` mints, which until now were listed and revoked only in the console's Share links section. `action: "list"` takes `kind`: `build-link` answers every build link of the login's project under `value.buildLinks` (each with its `id`, `label`, `build`, `scope`, `audience`, `issuedBy`, `createdAt`, `expiresAt`, `notAfter`, `revokedAt`, `revokedBy`, `live` and `shareUrl`; `lastUsedAt` is null on every row and a warning says the platform does not record a link's last use), read from the platform's access token list, which stores no token value and whose api tokens never appear here; `preview` keeps the emulator preview list alone; `both` (the default) answers the preview list with the build links beside it, and `buildLinks: null` with a warning when their list failed, so unknown is never read as none. `action: "revoke"` with `kind: "build-link"` and a `tokenId` (or the link itself as `url`, read by its `share=` part) kills a build link under the same member approval the preview revoke takes (`extension_shares.revoke`, scope `{ tokenId }`): the first call answers `approval-required` with the approval page, the retry with that `approvalId` answers `revoked` with `alreadyRevoked`; a malformed reference answers `bad-request` before the platform is asked, and a preview share id keeps the artifacts lane. Both answers carry the project's Share links page.
- `extension_release_status` with `include: ["releases"]` (the default) answers the project's visibility explicitly: `value.releases.projectVisibility` is `public` or `private` as the platform records it, read from the project's visibility record with the login that covers the project, with `projectVisibilitySource` saying `platform`, or `registry` when no login covers the project (or the platform read failed, which a warning names) and the registry's meta.json answered instead, and `null` when neither could be read. `channelUrlWithheld`, the per-channel links and the registry's `visibility` field stay as they were, so a share on a private project no longer has to infer the project's visibility from the withheld link; when the platform's record and the registry's meta.json disagree, a warning says which is which and that saving the console's Visibility section republishes meta.json.
- `extension_release_status` with `include: ["listing"]` reads each store's saved extension.dev listing as a plain read, which until now existed only as the diff `extension_submit` `action: "sync-listing"` computed: `value.listing.listings[]` carries, per store (the four stores, or the one `store` names), the title, summary, description, categories, license, support email, homepage URL, privacy policy URL and its attestation, the single purpose, the search terms, the number of permission justifications, the per-store notes (reviewer, release, certification, privacy), the icon and screenshot counts (never bytes or hashes), `updatedAt`, the store's console page and `lacks`, the fields the listing still has empty in a fixed order (title, summary, description, category, license, supportEmail, homepageUrl, privacyPolicyUrl, icon, screenshot). The hint says it per store (`chrome: titled "PII Shield", 1 icon, 0 screenshots; lacks license, homepageUrl, screenshot`), that the platform sends the listing to a store only on publish, and names `sync-listing` and `preflight`. The listing is copied by name, so a field the platform adds never leaves the server unnamed; a store whose listing could not be read is named in a warning while the others answer, and a read of one store that fails answers the platform's refusal. The call tracks on that store's console page, or the Submissions page for all four.
- `extension_submit` `action: "preflight"` on a store whose credentials are saved and whose "Store publishing" switch is off answers `store-not-connected`, for every store, instead of a readiness answer failing `store.enabled` alone with no link to the switch. `value.connectUrl` is the console's store settings page for that store (the page the missing-credentials answer names), `nextStep` is `connect` with it, and the hint says the credentials are saved and only the "Store publishing" switch for that store is off, names the page, and says the console's Connect flow will save the credentials and turn the switch on in one step soon. Every other failing combination keeps the readiness answer, and a Firefox store with its credentials missing keeps the answer that names the two AMO values. The Firefox `store-not-connected` answer, in both cases, also carries the source archive: `value.stores.firefox.sourceArchive` and its sentence in the hint when the platform sends the `store.firefox_source_archive` check, or, while the platform omits it before the store is connected, one sentence saying the Firefox store settings also hold the Source archive switch Mozilla's review needs for a bundled build, so the owner meets the setting on the first trip to the page instead of after the store is connected.
- `extension_submit` `action: "configure-store"` changes a store's settings from the chat, which until now needed the console for every one of them: `store` (chrome, firefox, edge or safari) and `storeSettings` with only the keys that change, `enabled` (whether the platform submits to that store), `submissionMode` (the store's own mode id: chrome draft-until-public, draft, public or staged; edge draft or review; firefox unlisted or listed; safari draft; dry-run on any store), and for Firefox `sourceArchive` (repository or none) and `releaseChannel` (listed or unlisted, the same write as the mode). A mode id is written as every field the platform derives it from, so the id the next preflight answers is the one asked for. The write takes the same owner approval as `extension_builds` `configure`: the first call answers `approval-required` with the change as the platform computed it (`value.changes`, the approval page in `value.trackUrl`, the console store settings page in `value.checkUrl`), a second call with that `approvalId` applies it once, and `store-configured` answers what changed (`value.changes`), the console store settings page in `value.trackUrl` and `nextStep` `preflight`. Credentials stay console-only: a `storeSettings` key that names one (issuer, secret, token, key, client, p8) answers `credentials-console-only` before anything is sent, with the console connect page in `value.connectUrl` and the field labels the console form shows (the JWT issuer and the JWT secret for Firefox, the Chrome Web Store connect, the Publish API Client ID, Publish API key and Product ID for Edge, the App Store Connect issuer ID, key ID and private key for Safari), never the platform's secret names; a listing id, a publisher id, a bundle id or a raw mode flag is refused the same way with the console named. While the platform in front of the server does not take the change from a token yet, the answer says so and names the console page. The Firefox sentences that said "turn on Source archive in the console's Firefox store settings" now name this act first, and the Chrome draft answer names it for the submission mode in place of "a chat act for that store is not available yet". Every settings write (build settings and store settings) now goes through one helper, `approvedSettingsWrite`, whose `SETTINGS_WRITE_GATE` constant is the one place that says a settings write needs the owner's approval page.
- The Firefox answers say whether the platform attaches the AMO source archive a bundled build needs. `extension_submit` `action: "preflight"` reads the platform's `store.firefox_source_archive` check and answers `value.stores.firefox.sourceArchive` ({attached, setting, say}) with one sentence in the hint: "the platform will attach the source repository at the built commit" when the project's Firefox store setting Source archive is the repository, or "no source archive is configured; Mozilla requires matching sources for a bundled build" with the console's Firefox store settings page to turn it on. A real submit with firefox among the stores answers `value.firefoxSourceArchive` and says "sources attached" or "no sources attached" in the hint, read from the platform's submission record (`sourceArchive`) when it carries the field and otherwise from the store setting the platform answered at submit time, never guessed; with neither, it says the record does not carry it and where the setting is read. The tool description says a Firefox upload carries the source repository at the built commit when that setting says so.
- `extension_builds` `action: "get"` keeps a build's own browser file links as the platform answers them: `artifacts[].downloadUrl` for `<browser>.json` and `<browser>.integrity.json` and `browsers[].integrityUrl` name the registry file, on the same lane as the package download, instead of the project's console page. A registry link to a build's own run record (`build.json`, `deployment.json`, `build-logs.json`) now answers that build's console page, never the project root.
- An approval this server minted is presented to the platform as the project that minted it, whatever login became active since. The platform answers an approval only to a token of the project that asked for it, and a call with no `project` uses the most recent login in a config dir several chats share, so a login to another project between the mint and the retry made the retry ask as the wrong project and read `APPROVAL_UNKNOWN` for an id minted a minute earlier. Every mint is now recorded in `approvals.json` beside the login store (per server: the id, the project from the minting token's own claims, the act, its fingerprint, the approval URL, the mint time and the expiry, kept for the platform's seven-day retention after the expiry), and a call carrying a recorded `approvalId` with no `project` is made as that project; the record is a file, so a rebuilt or reconnected server reads it too. A call that names another project for a recorded id answers `approval-rejected` (`ApprovalOtherProject`) before the platform is asked, naming the minted project and the call that continues it; a pending answer carries the approval URL the mint answered; and an unknown answer for a recorded id names the project it was minted for and the project the call resolved ("minted for acme/leon and this call resolved acme/rebeccat"), in place of "may have been minted for another server or project". A fresh approval requested for the same act (same project, action and fingerprint) marks every older live record of it replaced: the `approval-required` answer carries `replaces` with the older ids, and a call that presents a replaced id answers `approval-rejected` (`ApprovalReplaced`) naming the current id and its approval URL before the platform is asked, so the stale id is never spent; on 2026-10-22 an owner approved three approvals for one configure because nothing said the first two were stale.
- `extension_submit` `action: "preflight"` on a Firefox store with no saved AMO credentials answers `store-not-connected`, the shape Chrome already answers, instead of three failing checks (`store.enabled`, `store.config_present`, `store.credentials_present`) whose docs link says nothing about Firefox. `value.connectUrl` is the console's stores settings page for the project, `nextStep` is `connect` with that page, and the hint says what to paste where: Mozilla issues the two values once at https://addons.mozilla.org/developers/addon/api/key/ (the JWT issuer and the JWT secret, as the console form labels them), the console form takes them with the add-on id or its AMO dashboard address, and store publishing is turned on there; the platform's secret names are still never printed. The failing checks stay under `value.stores.firefox.failing`; a Firefox store whose credentials are saved keeps the plain readiness answer.
- A call with no `project` no longer follows a login made by another process. The login store is one file shared by every process on the machine and a login moves its `active` pointer to the newest entry, so a running server that read it on every call acted on whatever project was signed in last anywhere on the machine: on 2026-10-22 `extension_release_promote` reached rebeccat while every call before it had resolved leon, because another process had signed in to rebeccat a minute earlier. Now the first unnamed resolve on a server keeps the login it chose, per store file and per platform server, and every later call with no `project` (every token-scoped tool: `extension_release_promote`, `extension_publish`, `extension_submit` and its store acts, `extension_builds` acts, `extension_release_status`, `extension_shares`, `extension_workspace`) uses that same entry while it is stored; only a login or logout made through this server, or a rename the platform answers, moves it, and a named `project` never consults it. When the machine's newest login differs from the one this server keeps, the answer warns which login it used and names the `project` value or the `extension_auth` login that switches; `extension_auth` (action: status) says the same and marks the server's default as the active login. The `project` input says so in place of "the most recent login is used".
- `extension_release_status` with `include: ["stores"]` no longer calls a store record that was never written unreadable. The registry answers 404 for `stores/health.json` until the mirror's first store health probe and for `stores/status.json` until the end of the first submission, so a 404 on either now answers the readiness reader's own sentence: "the project has no store health record yet; the platform writes it on the first store health probe (a store connect or a credential recheck triggers one); both start from the console Submissions page: <url>" and "the project has no store status record yet; it is written at the end of the first submission; extension_submit runs one", and a store whose configuration is otherwise unknown reads "configuration unknown (no store health record yet)". A 404 on `stores/submissions.json` reads as "no submissions recorded" instead of "submissions unknown". "unreadable" stays for a 5xx, a network failure and any refusal that is not a 404. Both readers take the sentences from one source, so they never disagree.
- The STORE.md reader behind `extension_submit` `action: "preflight"` and `action: "sync-listing"` takes a single `- Category:` value up to its trailing parenthetical note for every store, so `- Category: Privacy & Security (Chrome Web Store)` reads as "Privacy & Security" on Firefox too instead of "category: not in STORE.md"; only a line that lists several categories reads a note naming stores as the stores that category is for, and a category without a store note on such a line applies to every store. A trailing note on the `- License:`, `- Support email:` and `- Homepage:` lines stays out of the value the same way. When STORE.md has the line and the reader could not take it (a category line naming other stores only, a support email that is not an address, a value over the listing's limit), the advisory's `notCovered` line and the reconciled check message name the line and the shape the reader takes, for example "category: the `- Category:` line in STORE.md names chrome and edge only; the reader takes `- Category: <name>` for every store, or `- Category: <name> (Chrome), <name> (Firefox)` per store", instead of "not in STORE.md". The tool description now names every `## Listing` line the reader takes: name, summary, description, category, license, support email, homepage URL and search terms.
- `extension_submit` `action: "preflight"` no longer gives two instructions for one check. When STORE.md (or the built dist, for the icon) already carries what a failing or warning listing check asks for, the check's message is the coverage fact alone, for example "privacy policy URL found in STORE.md (<url>), not yet in the console listing; sync-listing writes it.", and the platform's "add it to STORE.md" sentence is dropped; a check STORE.md does not cover keeps the platform's words untouched. The same rule covers the title, description, license, category, support email, search terms and icon checks.
- A Safari session whose background has gone idle no longer answers the Chromium MV3 sentence. When the engine's control channel answers "no executor connected" on a Safari session, the call first tries once to wake the extension: with a safaridriver session recorded in ready.json it reloads the automation window's page when a content script matches it, or sends the window to the first page a content script match names, waits up to 8 s for ready.json to stamp the executor attached again, and runs the verb again; the answer then carries `woke: true` in `value` and a warning that says what woke it. When the executor does not come back, or there is no session to send an event through, the answer says that Safari unloads an idle background page about 30 s after its last event and that it comes back on the next extension event, not on its own, names when the executor detached, says what the call tried, and carries `woke: false` with the hint that `extension_open` url (or a page opened in Safari, or a toolbar click) wakes it and that a page-context `extension_eval` with a url needs no background on Safari. `extension_storage`, `extension_open` url and `extension_eval` through the executor all answer this way; a Chromium or Firefox session keeps the engine's wording.
- `extension_eval` on Safari with no `context` now evaluates in the automation window's page over the dev session's WebDriver connection when ready.json records one, instead of riding the background, and says so in a warning; `context: "page"` already went that way. `content` and `background` still go down the bridge.
- `extension_open` url on Safari gives its confirmation read a 10 s budget and reads the tab list at least twice before calling the navigation unconfirmed, since that list rides the extension's background, which answers slowly right after it wakes; the unconfirmed sentence names that.
- The hint for a Safari session that records neither a safaridriver session nor a reason no longer blames an older engine: it says the engine's launcher stamps the session, or why it opened none, only once it reaches its WebDriver step (after the app opens and the extension is enabled, with a session request that alone waits up to 30 s), so a contract with neither means that step has not concluded or the launcher never reached it, and to read the launcher's last line with `extension_logs`, call again in 30 s, or restart with `replace: true`.
- `extension_wait` with `for: "rebuild"` no longer confirms a reload with a stamp older than the compile: a `reloadedAt` counts only when it lands after the new `compiledAt` and after the stamp read at call time, whatever `since` says, so a Safari session whose previous app re-sync was stamped two minutes before the edit keeps waiting for the re-sync of this compile (as a Chromium session does) instead of answering "reloaded, after this compile" with the old stamp and `waitedMs: 0`.
- `extension_dev` for Safari says how the built app was signed. The answer (and `extension_wait`'s ready and compiled-not-attached answers for that session) carries `signing: { requested, identity, appPath }`, read with `codesign -dv --verbose=2` from the app the session's xcodebuild line names, or from the engine's layout (`dist/safari-xcode/.derived/Build/Products/Release/<AppName>.app`, the app name from `appName` or the manifest name) when the log carries no such line; `identity` is `team:<id>`, `ad-hoc`, or `unknown` with no claim when the app cannot be read. When a `developmentTeam` was requested and the app is ad-hoc, a warning names the cause (Xcode has no account for that team, which xcodebuild prints as "No Account for Team"; the session log is read for it) and the fix (sign in to Xcode with that team's Apple ID, set `developmentTeam` to a team Xcode already knows, or drop it for an ad-hoc build); an app signed by another team than the requested one is named too. The last identity is recorded beside the session marker, and when it differs from the previous run's the hint says Safari treats the newly signed app as a new extension that must be enabled again, which `enableExtension: true` does without a Settings trip. The `developmentTeam` description no longer claims a storage reset: an ad-hoc rebuild keeps `storage.local`.
- `extension_eval` says what Safari can and cannot reach: the description carries one Safari sentence (page contexts only, through the automation window's WebDriver session; the background and the extension surfaces are out of reach; `extension_logs` reads the background), and a background or surface eval on a Safari session answers `safari-context-unreachable` (`E_SAFARI_CONTEXT_UNREACHABLE`) in place of the engine's CSP refusal, naming the limit (the extension's CSP forbids eval in its own documents and Safari has no inspector path around it, unlike CDP and the Firefox debugger protocol) and the alternatives: `extension_logs`, `extension_open` url plus a page-context eval in the automation window, `extension_screenshot`, and that a page opened in a regular Safari window is outside the session; `until` stops on it. The ended-session answer after a Settings trip (`extension_eval`, `extension_wait`, `extension_doctor`, `extension_screenshot`) now says the session ended while the dev server did not, and that `extension_dev` again with `replace: true` and `enableExtension: true` (plus `allowEval: true` for eval) gets a driveable window with no Settings trip, in the words `enableExtension` itself uses.
- A project renamed in the console no longer strands its login. The platform resolves a project token by the project id it was minted for, so every token keeps working after a rename; the MCP notices the new slug on the next whoami, rewrites the stored login under the new `<workspace>/<project>` key with the project id beside it, keeps the old key as an alias for one more answer, and says once "the project <old> is now <new>; its login moved with it, pass project: '<new>' from now on". A platform refusal `PROJECT_MOVED` (the device login for an old slug, or any project read) answers the same sentence and moves the login; a `PROJECT_NOT_FOUND` from an older platform now carries the way to find the new slug (`extension_workspace` action projects through another login of the workspace) and the `extension_auth` call that re-logs. Logins now record `projectId` when the platform answers it.
- `extension_dev` with browser safari takes the Safari options `extension_build` carries (`appName`, `bundleId`, `macOsOnly`, `forceRegenerate`) plus `developmentTeam` and `enableExtension`, and passes them to the engine's dev verb as `--app-name`, `--bundle-id`, `--development-team`, `--macos-only`, `--force-regenerate` and `--enable-extension`; a Safari option on another browser answers `safari-only-option` and a malformed bundle id `invalid-bundle-id` before anything is spawned, the same refusals as `extension_build`. A Safari session that compiles but never attaches no longer reads "usually transient": `extension_wait` (and the `extension_dev` answer whose ready.status is compiled-not-attached) says the extension is not enabled in Safari yet, names `enableExtension: true` with `replace: true` and the one-time Accessibility grant it needs, or the one-time setup in Safari Settings (Developer > Allow unsigned extensions, Extensions > turn it on, Websites > For other websites > Allow), and when the session was started with `enableExtension` it names the Accessibility grant and `extension_logs` for the engine's enable lines.
- `extension_open` with a `url` says what the agent could not see before: the answer carries `tab {active, visibilityState}` and `viewport {width, height}` for the tab it opened (read from the page over the debug port on Chromium; on Firefox `active` comes from the engine's tab row and the viewport from the tab the fallback eval returns, omitted when the engine does not carry them) and `headless`, the state decided at launch, and the hint says that a hidden tab gets no IntersectionObserver callbacks until it is shown and that an element below the viewport is not observed until it is scrolled into view, so a walk reads "the element sits below a 769 px viewport" instead of blaming a headless browser. The tool description names the fields and the scroll rule. The tab rows the engine lists (`extension_dom_snapshot` listTabs, availableTabs and a Gecko resolvedTarget) carry the same `active` flag.
- `extension_start` with `allowControl` or `allowEval` names the id change: the controlled copy of the build has its own extension id (an unpacked id comes from its folder), so the answer carries `buildExtensionId` (what `dist/<browser>` gets) beside the session's id, warns that every chrome-extension:// and chrome://extensions/?options= address for the run uses the copy's id and that the copy shares no chrome.storage and no grants with the plain build, rewrites a `startingUrl` that named the plain id, and no longer promises carried-over storage in the profile note for the copy.
- After a Chrome draft upload, `extension_submit` says that testers can already install the same build from its extension.dev build link (`extension_publish`) while the store review has not run, so a draft is never read as "nothing to hand out".
- `extension_open` no longer tells a headed session to relaunch headed: when a surface document does not appear within 3 s in a headed session, the warning says what happened (an `options_ui.open_in_tab: false` page is hosted inside chrome://extensions, at `chrome://extensions/?options=<id>`, a view the target list does not show; a popup closes when focus moves) and that the document was rendered in a tab; the headless wording and the relaunch advice are kept for headless sessions only.
- `extension_submit` reads the project's saved submission mode before it asks for anything and every sentence follows it: under the default modes (Chrome draft-until-public, Edge draft) the approval reads "Upload build X as a store draft: not published and not sent to review" and the answer keeps "Nothing goes to review until you publish"; under a saved Chrome public or staged mode, or Edge review, the approval reads "for store review: the saved mode sends the upload on to review" and the answer says so with the console setting that stops at a draft. `action: "preflight"` answers the saved mode under `value.stores.<store>.submissionMode` (id, label, description, fromHere) and names it in the hint once every check is green.
- The store sentences no longer promise an "unlisted draft": a Chrome or Edge upload is a draft that is not published, nothing goes to review until you publish, and the item's visibility (public or unlisted) is set once in the store's own dashboard, since no store API sets it (a new Chrome item defaults to public).
- `extension_project_create` names the device code's deadline: the pending answer carries `expiresAt` and `expiresInSeconds` (fifteen minutes from the first call) and says to call again right after approving, the waiting answer repeats it, and `create-expired` says that an approval given near the end of the window still reads as expired, that no project was created, and to restart without the old `deviceCode`.
- `extension_submit` `action: "preflight"` reads the platform's own Chrome submission record and, while it carries a pending review, answers `nextStep` `done` with the submission page, `value.chromeReview` (submission id, store state, build, version, since) and a sentence that a new submit would upload another draft beside the review; it offers the submit step only when no review is pending. `storeMd.onListing` names what STORE.md carries that the listing already has, apart from `covers` (what a sync would fill).

## 10.18.1

- `extension_publish` names the extension by the build's manifest name (`extensionName`, carried on every build index item and answered by the platform) in `tellThem`, and warns when the project's display name on extension.dev differs, naming the console project settings page where it is changed; the MCP still reads general settings only.

## 10.18.0

- `extension_submit` `action: "preflight"` names the privacy policy URL STORE.md carries on the covers line and appends "STORE.md carries <url>; sync-listing writes it to the listing" to the platform's privacy warning, so the warning and the coverage never contradict each other.
- The hosted privacy page is gone; the privacy policy URL is the developer's own address in STORE.md (`- Privacy policy URL: <address>` under `## Privacy and data use`), and `extension_submit` `action: "preflight"` names that line when it is missing. `storeMd.privacyPolicy`, `privacyPageUrl` and the privacy link kind are no longer answered.
- `extension_inspect` (1,625 to about 1,300), `extension_dom_snapshot` (1,578 to about 1,200), `extension_start` (1,433 to about 1,250) and `extension_create` (1,414 to about 1,350) are cut on the same shape, with the picking rules in the `url`, `tabUrl`, `context` and `allowControl` input descriptions.
- `extension_auth` (1,946 to about 1,700), `extension_eval` (3,370 to about 1,600), `extension_wait` (2,248 to about 1,900) and `extension_open` (1,939 to about 1,000) are cut on the same shape; the per-context routes, the per-action answers and the per-surface behavior moved into the `context`, `action` and `surface` input descriptions.
- `extension_shares`'s description is cut from 2,153 to about 1,200 characters; each action's answer shape and the reconciliation counts moved into the `action` input description.
- `extension_project_create`'s description is cut from 2,968 to about 1,900 characters; the grant's life, the resume file and the batch pacing moved into the `deviceCode` input description.
- `extension_release_status`'s description is cut from 3,290 to about 1,600 characters, with each include's detail in the `include` input description, and `extension_release_promote`'s from 2,675 to about 2,050 on the same shape.
- `extension_builds`'s description is cut from 4,371 to about 1,350 characters: the verb, the act contract, the two siblings and the two costs; each action's detail is in the `action` input description.
- `extension_publish`'s description is cut from 4,111 to about 1,950 characters on the same shape; the two-link rule, the withheld channel link and the artifact refusal stay, and the answer field catalog is named rather than narrated.
- Every tool carries an annotation `title`, the verb phrase a client shows in a consent prompt ("Submit to a store", "Publish a build link", "Promote a release"), and a shrink-only budget spec pins each tool's description length so descriptions can only get shorter. `extension_submit`'s description is cut from 9,570 to about 1,500 characters: the verb, what it records and which links it makes, what it is not for (extension_publish, extension_build), its surprising defaults (a dry run, least public) and where the project comes from; the per-action detail moved into the `action`, `browsers` and `dryRun` input descriptions, and the act answer contract (value.outcome, value.links, -dispatched) moved into the server instructions, where it now covers every platform act.
- `extension_submit` `action: "publish"` takes `browsers: ["edge"]` as well as `["chrome"]`: an Edge Add-ons draft goes to Edge's certification review through the platform's Edge store action lane, with the same approval, `value.outcome` (Edge's own operation state in `storeState`), `value.links` and `publish-dispatched` answers as Chrome, in Edge's words; with no Partner Center credentials pasted or no product linked it answers store-not-connected or store-item-not-linked before anyone is asked.
- A platform refusal `PUBLISH_IN_FLIGHT` or `CANCEL_IN_FLIGHT` (the platform already dispatched that act on this submission and its record has not confirmed the store's answer yet, so it did not dispatch again) answers `publish-refused` or `cancel-refused` before any approval is asked, with a hint to read the record and never send the act again while it is on its way.
- Every platform answer carries `value.server {version, builtAt}`, the package version and the build time of the file this process loaded, and a warning "The server you are running was rebuilt at <time>; reconnect once to use it." whenever the file on disk is newer than the running one, so a reconnect happens when it does something and never on a guess. The store's own dashboard page is information only: the preflight hint no longer says where the Chrome Web Store item is (it stays in `value.itemUrl` and the `item` links row), a non-Chrome draft's done step points at the project's store settings on extension.dev instead of the store dashboard, and the Chrome playbook's step 6 says so. The server instructions carry the retry rule: after a `-dispatched` answer read the record and never dispatch again; after a refusal with `value.approvalRefunded` true call again with the same approvalId; after a "may have been spent" warning read the record before asking for a fresh approval.

- An act whose dispatch the platform refused before anything ran keeps its approval: when the refusal carries `approvalRefunded: true` (the platform deleted the grant's used marker because the code host answered 4xx or the mirror lacks the input), `extension_submit` (a real submit, `publish`, `cancel`, `rollout`), `extension_release_promote` and the other ship acts answer `value.approvalId` unchanged, `value.approvalRefunded: true`, `value.nextStep {kind: "retry", say, url: null}` and a hint to call again with the same arguments and approvalId, and the "may have spent" warning is gone; a refusal without that flag keeps the old warning. The approval-required answers name what is being approved: the platform's mint answer now carries `subject {extension, version, storeVersion, buildSha, store}`, carried as `value.subject`, and the spoken step reads "Approve sending PII Shield 0.1.0, build 111d167 to Chrome's review at <url> before <expiry>." (publish) or "Approve submitting PII Shield 0.1.0, build 111d167 at <url> before <expiry>." (a real submit). Approvals the platform mints for ship acts now live twelve hours, so `value.expiresAt` reads hours ahead instead of fifteen minutes.

## 10.17.0

- Every platform act answers what the platform RECORDED after the act, read back from the platform's own record, and every link it made or touched. `extension_submit` (a real submit, `publish`, `sync-listing`, `cancel`, `rollout`), `extension_publish`, `extension_release_promote`, `extension_builds` (`rebuild`, `recheck`) and `extension_project_create` carry `value.outcome: {recorded, status, storeState, checkedAt, source: "platform-record", waitedSeconds}` and `value.links: [{kind, url, audience, expiresAt, made}]` (kinds `track`, `share`, `channel`, `submission`, `item`, `approval`, `privacy`, `build`, `release`, `project`; `made` is true only for a link this act created), and the hint names the made links in one sentence ("Made: the tester link (expires October 27) and the submission page." or "Made: no new links."). After the platform accepts the act the server polls its record (the submissions read, the release read, the build read, the share record) every 5 seconds for up to `waitSeconds` (a new input on those tools: default 180, 0 to 600, 0 reads once), and answers the recorded status: `submitted`, `in-review`, `canceled`, `rolled-out`, `listing-synced`, `published`, `promoted`, `built`, `rechecked` only with `outcome.recorded: true`, and `submit-failed`, `publish-failed`, `promote-failed` or `build-failed` when the record reads failed. When the bound passes first the status is the act's dispatched form (`submit-dispatched`, `publish-dispatched`, `cancel-dispatched`, `rollout-dispatched`, `sync-listing-dispatched`, `promote-dispatched`, `rebuild-dispatched`, `recheck-dispatched`) with `outcome.recorded: false` and the hint "The platform accepted the act at <time>; its record has not confirmed the result yet. Watch <trackUrl>; call <read> to read it." A Chrome publish answers `in-review` only when the submission record carries Chrome's own state (`storeReview.state`, answered as `outcome.storeState`), and `publish-dispatched` until then even when the run finished; `extension_builds` `rebuild` no longer answers `dispatched` and `recheck` no longer answers `checking`. `tellThem` and `nextStep` are unchanged. Step 6 of the Chrome Web Store goal playbook says the same.

## 10.16.0

- The template catalog is read from the registry at the pinned commit (`registry.extension.land/extension-dev/catalog/latest.json`, then the pinned document, with template files from GitHub at that pin); the bundled snapshot is refreshed to the live catalog and the pin contract reads the templates app's pinned catalog file instead of the media submodule.
- The hosted privacy page's address is `https://privacy.extension.land/<workspace>/<project>`. `extension_submit` `action: "preflight"` and `action: "sync-listing"` derive that address when the platform's preflight read carries no `privacyPageUrl`, and the platform's own `privacyPageUrl` still wins when present; the `extension_submit` description names the same host. The earlier `https://<workspace>.extension.land/<project>/privacy` shape is gone because Cloudflare refuses a route with a wildcard inside the hostname.

## 10.15.1

- `extension_release_status` store rows carry the platform stamp the mirror recorded: `lastSubmission` and each `submissionHistory` row answer `storeVersion: {packaged, displayed, source, buildNumber}` and `storeCrxVersion` (the version the store reported for the package) when the record holds them, so "which version did Chrome receive" is answered from the record instead of guessed from the manifest.
- A Chrome draft's `submitted` answer carries `value.nextStep` kind `publish` with `url: null`: the next act is `extension_submit {action: "publish"}`, a tool call, never the Chrome Web Store dashboard; the item's dashboard page stays in `value.itemUrl` as information only.
- `STORE.md`'s "Privacy and data use" section can be the project's privacy policy. The parser reads the section's prose and the line `- Privacy policy attested: yes` (`privacy: {section, attested}`), and when `STORE.md` has the section and the attestation and no privacy policy URL, `extension_submit` `action: "preflight"` with `projectPath` counts the privacy policy as covered and says "privacy policy: published at <url> from STORE.md's Privacy section; edit that section to change it", with `value.stores.<store>.storeMd.privacyPolicy: {url, derived, source}`; the URL is the platform's `privacyPageUrl` from the preflight read, or `https://<workspace>.extension.land/<project>/privacy` derived from the project (`derived: true`). `action: "sync-listing"` fills `listing.privacyPolicyUrl` with that URL and says the same sentence. When the section or the attestation is missing, the advisory names the exact line to add (`## Privacy and data use`, `- Privacy policy attested: yes`) and calls the page a public privacy policy URL the stores can link, never one a store accepts. The Chrome Web Store goal playbook gains step 4 for that advisory, and the later steps move to 5, 6 and 7.
- `extension_open` with an extension url (`options/index.html` or a full `chrome-extension://` address) no longer blames the bundle when the extension is mid-reload. When no live page target appears and the session's ready contract shows a reload (the executor detached, or a reload, reconnect or compile stamped within the last 15 s), or the browser lists no target of the extension at all, the server waits up to 8 s (bounded by `timeout`) for the extension to come back, retries the navigation once, and answers `navigated` with `value.retriedAfterReload: true` and a warning saying the first attempt landed while the extension was reloading. When it does not come back, the answer is `extension-reloading` (`E_EXTENSION_RELOADING`, `value.reload: {kind, at}`, `value.waitedMs`) with "The extension is reloading (...), so <url> could not be opened ... The file is not implicated." and the hint "Try again in a moment." The "may not exist in the extension bundle" answer stays for an extension that is loaded and did not reload. The settle poll is now bounded by `timeout` too. A `target-not-found` from extension_screenshot, extension_dom_snapshot, extension_inspect or extension_eval on Chromium now reads the same reload stamps: a tab extension_open had opened on one of the extension's pages answers "it showed <url>, one of the extension's own pages, and the extension reloaded (...). Chrome closes an extension's pages when it reloads, so that tab is gone.", any other gone target says the reload may have closed it, and both carry `value.extensionReloaded: {kind, at}` and a hint to open the page again.
- `extension_submit` `action: "preflight"` no longer reports a store as blocked by the two checks the submit call itself fills: it sends the same default channel the submit uses (`stable`) so "Release selected" passes, and when no `buildSha` was given it leaves "Build selected" out of `value.stores.<store>.failing`, marks `namedBySubmit: ["build"]`, counts `canSubmit` from the remaining checks, and says "The submit call names the build; extension_builds lists the shas." A linked, healthy Chrome store with every listing check green therefore answers `preflight-read` with `nextStep` kind `submit` instead of "cannot be submitted yet".
- A store act or publish resumed with an approval the platform reports expired (410 `APPROVAL_EXPIRED`) mints a fresh approval for the same act, with the same fingerprint, in the same call, and answers `approval-required` with the new `value.approvalUrl`, `value.expiresAt`, `value.trackUrl`, `value.nextStep` kind `approve` and `value.expiredApproval: {approvalId, status: "approval-expired", expiresAt}`; the hint reads "That approval expired at <time>; here is a fresh one: <url>. Click Approve, then tell me." and a local server opens the new page once. An approval the platform does not know (404 `APPROVAL_UNKNOWN`) is still refused, as `ApprovalUnknown`, with "The platform does not know approval <id>; it may have been minted for another server or project.", and a platform message that ends in a period is no longer followed by a second one.
- `extension_publish` answers a `tellThem` of at most three lines with no share token: "Here is <project> to try: <page url>. It works until <date>.", and while the page is held a second line with the Chrome run command and "(Firefox and Edge: swap the browser name twice)". It reads the platform's short link (`link: {kind, url, id, expiresAt, pointsAt, audience}` and `previewCommands` on `<workspace>.extension.dev/<project>/builds/<sha>/<browser>.zip?share=<id>`); a platform that still answers registry URLs with `?t=` keeps its commands, and `tellThem` then shows only the Chrome command and "Ask me for Firefox or Edge." A run URL is wrapped in double quotes only when it holds a shell character such as `?` or `&`. The hint is two sentences, what to send and where to watch; the longer explanations move to `value.notes`, and every published answer carries `value.link.id` (null without a short link) and `value.trackUrl`, the console Share links page.
- The server instructions carry the deployment rule beside the extension.dev-first line: anything that leaves the person's machine goes through extension.dev (builds for others from the platform build, links from `extension_publish`, stores from `extension_submit`, and a store only when the person asks for one); `extension_build` output is never offered as a way to share, send, test with someone or submit; a store's version refusal is the platform's to absorb; and after a stop that asked for one action (connect, link, approve) the next message re-runs preflight without being told. Steps 2 and 3 of the Chrome Web Store goal playbook now call preflight again on the person's next message instead of waiting to be told they are back.
- `extension_submit` answers whose `value.nextStep` kind is `connect` or `link-item` carry `thenCall: {tool: "extension_submit", args: {action: "preflight", browsers}}`, so an agent can resume without reading the sentence.
- A local server with a display opens a platform act's `value.approvalUrl` once in the default browser (`open`, `xdg-open` or `start`) when it answers `approval-required`, never twice for the same approval id, adds `value.approvalOpened: true` and says "The approval page is open in your browser; click Approve, then tell me." It never opens headless, in CI, on Linux with no display, from the hosted server, under `--no-ship` or with `EXTENSION_DEV_NO_AUTO_OPEN=1`.
- `extension_submit` and `extension_publish` answers carry `value.storeVersion: {packaged, displayed, source}` when the platform returns it, and drop a malformed one rather than inventing it. A store version refusal (`STORE_VERSION_NOT_ALLOWED` or the store's own message) answers `value.nextStep` kind `resubmit` with "The store already holds that version; extension.dev packages the next build with a higher build number, so build again and I resubmit."

- A dry-run `extension_submit` reads each store's connection record, the same one `action: "preflight"` reads, so a connected, healthy Chrome store with a linked item answers `value.verdict: "ready"` with the preflight's `value.nextStep` and a `value.trackUrl`, instead of `configured: "unknown"` and a link to add the store. The older store health record is read only when no connection record exists, and a store neither can describe reads "not checked" (`value.verdict: "not-checked"`). A blocked store answers its state (`store-not-connected`, `store-connection-failed`, `store-item-not-linked`, `store-not-configured` or `store-unhealthy`) with the connect or link step, and a real submission reads the same connection record and answers those states before asking for any approval. Every platform answer now also drops registry addresses (`registry.extension.land`, `/api/registry/`, `_extension-dev/` and `_extension-dev-system/` paths) and workflow file paths, and a registry object link becomes the console page for what it describes; a build's download link in a run command stays.

- `extension_submit {action: "publish", browsers: ["chrome"]}` (alias `review`) sends the newest Chrome draft, or the `submissionId` named, to Chrome's review through the platform's new publish act, which calls the Chrome Web Store API's `publishers.items.publish`. The first call answers `approval-required` with `value.approvalUrl`, `value.expiresAt` and the sentence "This sends the item to Chrome's review."; the call resumed with that `approvalId` answers `in-review` with `value.trackUrl` (the submission page) and `value.itemUrl` (the item's dashboard page). An unconnected account or an unlinked item answers `store-not-connected` or `store-item-not-linked` before anyone is asked. A Chrome draft's `submitted` answer now carries `value.nextStep` kind `publish` with "To send it to review, say publish; that is one more approval.", and step 5 of the Chrome Web Store goal playbook says the same and walks the publish approval.

- The server instructions carry a Chrome Web Store goal playbook of six steps for any ask that means getting the extension into the Chrome Web Store, a retry included: preflight first every time; on store-not-connected or store-connection-failed, and on store-item-not-linked, say the hint and wait; on a green preflight submit with dryRun:false, give the approval URL, its expiry and the track page, and resume with the approvalId; on submitted report the track and item links and say that the person sends it to review from the item's dashboard page with Submit for review, since no platform action does that yet; never lead with a do-it-yourself route and never name a secret. `extension_submit` answers the same path as data in `value.nextStep` `{kind: "connect" | "link-item" | "submit" | "approve" | "done", say, url}` on every preflight answer (null while failing checks remain) and on a real submission's connect, link, approval and submitted answers, derived from what the answer already read.

- `extension_submit {action: "preflight"}` no longer says the Chrome Web Store item is created on the first submission, because Google ended the API that created items on 2026-10-15. A healthy Chrome connection whose status says `connection.itemLinked: false` answers status `store-item-not-linked` with `value.trackUrl` (the store settings page), `value.newItemUrl`, `value.packageUrl` and `value.linkItemUrl`, and a hint of three sentences to say as they are: create the item once in the dashboard with that package and fill its Store listing and Privacy tabs, paste its dashboard address at the link page, then every build goes as an unlisted draft. A real submission the platform refuses with `STORE_ITEM_NOT_LINKED` answers the same.

- `extension_submit {action: "preflight"}` reads the Chrome Web Store connection the platform now reports per store (`connection: {kind, connectedAs, healthy, itemId}`, with `connectUrl` when nothing is connected) and points the person at it instead of listing secrets. With no account connected it answers status `store-not-connected` with `value.connectUrl`, `value.trackUrl` (the console store settings page) and a hint of two sentences to say as they are: "Connect your Chrome Web Store account once at <connectUrl>; Google asks for one click. Then I submit it as an unlisted draft, and nothing goes to review until you publish." A connection that failed its last check answers `store-connection-failed` with the reason before the same sentences. A healthy connection with no store item says the first submission creates it, and one with an item answers `value.itemUrl`, the item's dashboard link.
- A real `extension_submit` that the platform refuses with `STORE_NOT_CONNECTED` or `STORE_CONNECTION_UNHEALTHY` answers the same connect link and sentences instead of `submit-failed`, and a submission that recorded a Chrome item answers its dashboard link in `value.itemUrl`.
- The approval-required answer of a Chrome or Edge submission and of `sync-listing` carries `value.expiresAt` and says "Nothing goes to review until you publish."
- No `extension_submit` answer names a store secret any more. A platform message that names the secret settings a store reads (two missing Chrome secrets, say) now reads "Store credentials are missing." in every action's hint, message, value and warnings.
- The server instructions send a store ask through `extension_submit` preflight first, then the connect link when the store is not connected, then a draft submission, and say extension.dev comes before a release on a code host, an unlisted AMO version signed by hand or a TestFlight upload by hand.

- `extension_publish` reads the build answer's per-browser `integrity.fromEarlierRun` as the first sign of a stale integrity verdict, because the platform keeps run ids out of non-operator answers. Comparing `integrity.checkedAt` or the report's `generatedAt` with the build's `startedAt` stays the fallback.
- `extension_publish` checks that the share page answers before telling anyone to open it. During the public hold the page answers the platform's 503 hold page, and the publish answered `published` with a `tellThem` that promised it. A page that answers 503, or a hold answer with `retry-after`, now gives status `platform-held` (`ok: true`, the link is minted), `value.sharePage` with the page's status, a `tellThem` that names the run commands (they download the build from the registry and work now), and a warning that names what works now and what waits for the platform to open. `trackUrl` stays.
- `extension_builds get` and every platform answer replace a run link (`runUrl`, `htmlUrl`, `workflowRunUrl`) that points at the internal build repository or an Actions run with the console build page, in `build.*`, `run.*` and nested records alike, and drop the run's own id inside a `run` record. Production still sent the GitHub run URL in `build.runUrl` and `run.runUrl`.
- `extension_auth login` no longer warns that a project "may not be there" right after `extension_project_create` created it on the same server. The create now records the project and server in `created-projects.json` beside the stored logins, and the login's project check reads that record as proof the project exists.

## 10.15.0

- `extension_publish` no longer sends the person into a rebuild loop when the integrity verdict is older than the build's newest run. Each browser's verdict now carries `checkedAt`, `checkedRun` and `freshness` (the build answer's own per-browser `integrity.checkedAt` and `integrity.runId` first, else the report's `generatedAt` and `runId`, compared with the build's `runId` and `startedAt`; a missing time is unknown, never stale). When every failing verdict is from an earlier run, the refusal says so and offers a recheck instead of a rebuild. Every refusal carries `value.status`, one line on the build's state, what blocks and who unblocks, and `value.trackUrl` to the build page.
- `extension_builds {action: "recheck", buildId, browser?}` asks the platform to rerun the integrity checks on a build's stored artifacts without building anything. It answers the per-browser verdict, says when publish is now possible, and refuses a build or browser with no artifact, a build with a run in progress, and a second recheck within 60 seconds, each with the build page in `trackUrl`.
- Platform answers no longer say where or how the platform runs builds. `extension_builds` answered `runUrl` (a GitHub Actions run on the platform's internal build repository) in `rebuild`, `get` and `logs`, quoted it in hints ("The full CI run is at ...", "this rebuild is the one whose run reads runId ... (https://github.com/...)"), and an agent following it told a person the internal repository's name and that "GitHub still shows the run as in progress". Rebuild, get and list now carry the run id only as `internal.runId`, an opaque value for matching a rebuild to its build that no hint quotes; `runUrl` and `runCorrelation` are gone; the logs hints name the console build page instead, and the failed step, its lines and the platform's summaries still come back as data. Release history events and store submission history drop the run link too. Every platform tool's answer also passes one filter (`src/lib/run-privacy.ts`) that removes run links, run ids outside `internal` and internal repository names from `value`, `hint`, `warnings` and `error`, so a platform that still sends `runUrl`, or a message that quotes one, never reaches the person; www still sends `runUrl` to token callers until its own fix lands, and the MCP strips it. The `extension_submit`, `extension_project_create` and `extension_builds` descriptions and the store refusal hints no longer mention the internal build repository. No platform tool is operator-facing, so none is exempt.
- Every platform tool answers `value.trackUrl`, the console page where the person follows exactly what the call did, and names it in the hint. One table in `src/lib/track-url.ts` picks the page from the act: a project create opens the project page, a build, rebuild, get or logs opens that build's page (`/<workspace>/<project>/builds/<buildId>`, with the browser for logs), a promote or rollback opens the Releases page filtered to that channel (`releases?channel=<channel>`, or `releases/<releaseId>` when the platform names the release; the console has no page per browser), a cut opens Releases, a store submission or cancel opens that submission's page, a rollout, preflight or listing sync opens that store's page (`submissions/<store>`, where the listing and the Chrome rollout live), configure opens Project settings, Build, create-channel opens Project settings, Channels, a publish or share opens Project settings, Share links with the build page beside it in `value.trackLinks`, and the reads open the page they read. An answer that waits on an approval carries the approval page as `trackUrl` and `value.checkUrl`, the page to check once it is approved. The page derives from the call's `api` through the entry 212 resolver, never the environment alone. A rebuild used to answer only the generic builds page, and sync-listing the submissions list instead of the listing it changed.
- `extension_screenshot`, `extension_dom_snapshot`, `extension_inspect` and `extension_eval` take `targetId`, the `target.targetId` that `extension_open` answers or one from `extension_dom_snapshot listTargets: true` (a CDP target id on Chromium, the tab's `browserId` on Firefox, now listed as `targetId` there too). It picks that page directly and ignores `url`; a target that is gone is refused with `E_TARGET_NOT_FOUND`, naming the live ones. A `url` that matches several tabs showing the identical page no longer answers `ambiguous-target` with a hint no url could satisfy: the tools use the most recently active target on Chromium (the debug port lists targets by last activity) and the selected tab, else the most recently created one, on Firefox, and warn naming the pick and the other targetIds. Pages that differ are still refused, and that refusal now lists each candidate's `targetId` and names `targetId` as the way out.
- An approval the owner has not acted on yet now reads as waiting, not refused, in every tool that resumes one. `extension_submit {action: "sync-listing", approvalId}` answered a platform 403 "This approval has not been granted yet." with `ok: false`, status `sync-listing-refused`, the store row `approval-rejected` and `error.name: "ListingRefused"`, which an agent could read as the owner declining, or answer by requesting a fresh approval that voids the one about to be clicked. It now answers `ok: true`, status `approval-pending`, with `approvalId`, `approvalUrl` and `retryAfterSeconds` in `value` and a hint that a person approves at the link. "Declined" and "expired" get their own statuses, `approval-declined` and `approval-expired` (`ok: false`, `E_APPROVAL_REJECTED`, with the platform's words); a used approval keeps its "already used" answer, and an unknown or mismatched one stays `approval-rejected`. One helper in `src/lib/approval-outcome.ts` maps the platform codes to these answers, and `extension_builds` `configure` and `rebuild`, `extension_release_promote` (promote, `cut`, `rollback`), `extension_submit` (submit, `cancel`, `rollout`, `sync-listing`) and the approval check before `extension_shares` revoke all use it, so the approval check that reads a pending approval also answers `ok: true` where it answered `ok: false`.
- A call's `api` now picks every URL in its answer, not only the server it talks to. With `EXTENSION_DEV_API_URL` on a local platform, `extension_project_create {api: "https://www.extension.dev"}` answered `lane-closed` with a hint that sent the person to `http://console.extension.localhost`, because its console links, like those of `extension_workspace_create`, the batch create, the batch login refusal and the token lifetime notes, were built from the environment. Every console, userland, registry and templates host now comes from one resolver (`mcpOrigins` in `src/lib/origins.ts`): the call's `api`, else the environment, else production, with the local fleet (`localhost:3100`, `www.extension.localhost`) mapped to `console.extension.localhost` and `userland.extension.localhost`. The tool dispatcher hands every call's `api` to that resolver, so a helper that passes none still answers for the call's server, and the `EXTENSION_DEV_*_URL` surface overrides apply only when the call targets the same kind of server the environment names. The `lane-closed` answer from project, batch and workspace creation now carries `value.server`, `value.publicHold` and `value.allowlistNamed: false`. During the public hold its hint says plainly that headless creation on that server is open only to allowlisted workspaces, that the platform's answer names no allowlisted workspace and no date, and that the console answers its gate page, so it no longer suggests a console route the hold also blocks. Outside the hold, the hint names the console of the server the call targets, also in `value.consoleUrl`. `extension_workspace_create` maps a lane that closed after approval to `lane-closed` as well, where it answered `create-denied`.
- `extension_auth {action: "login", project}` says when the target server may not hold the project. Before it starts the device flow it asks the server's `/api/projects/resolve` with no login. The platform answers that only for public projects and never says whether a private project exists (ruled 2026-08-02), so the start cannot refuse. When the project is not public there and this machine holds no login for it on that server, the pending answer carries `value.projectCheck` (`server`, `publicProject: false`, `loginsForThisSlugElsewhere`) and a warning that names the servers where this machine holds a login for the same slug and points to `extension_project_create` with the same `api`. On resume, a code the approver canceled because the project does not exist answers `ok: false`, status `approval-refused`, code `E_AUTH_DENIED`, with the platform's message and `platformCode: "PROJECT_NOT_FOUND"`, where it answered `authorization-pending` until the code expired. A mint that refuses a missing project answers status `project-not-found` naming the server, where it answered `login-failed`. A plain denial stays `login-denied` and now carries the platform's message.
- `extension_publish` reads the build's per-browser status and integrity, the way `extension_builds get` does, before it hands out a link, and reports them in `value.artifacts`. A build whose `extension_builds get` said integrity failed for every browser (the served chrome.zip was 10 MiB of a 36 MB artifact, edge and firefox `failed`) answered `published` with a build link, a `tellThem` and a chrome run command that could not work. A build whose every browser artifact failed integrity or failed to build is now refused with `ok: false`, status `publish-refused`, code `E_ARTIFACTS_UNVERIFIED`, naming each browser's verdict and `extension_builds (action: 'rebuild')`; a pinned build is refused before any link is minted, and an unpinned one withholds the minted link and points to the console Share links section. `force: true` publishes it anyway with a warning. When only some browsers failed, the answer publishes with a warning naming them, drops them from `previewCommands` and the run commands in the hint, and `tellThem` says which browsers the link is good for. A platform that reports no integrity, or a build record that cannot be read, publishes with a warning that integrity was not checked.
- `extension_builds` says what failed instead of a summary it does not have. On a run that failed in a step every browser shares (checkout, the token exchange), `logs` answered every browser `pending` with no lines while `list` said `failed`; it now answers `value.run` first, with `failedJob` naming the job and step and that step's last 60 lines, leads its hint with "The run failed in <job> at step <step> before any browser built:" and those lines, and answers the browsers `skipped` with the platform's reason, never `pending` once the run has concluded. A platform that does not yet send `run` gets the same answer when every browser is pending on a build the detail calls failed, naming the step from the detail's `failureCause` and the build page. A browser marked failed with only success lines no longer gets "its lines lead with the platform's summary": the hint says it has no failure line and relays the platform's reason, and `run.validation` carries the manifest validator's errors, warnings and diagnostics per browser. `get` answers `failures` with the failed browsers and the validator's outcome, and `list` answers `partial` (with `runStatus` and `failedBrowsers`) where it said a bare `success`. The answer stays fenced as untrusted data.
- `extension_submit` gains `action: "sync-listing"`, which fills the extension.dev store listing for `browsers` from the project's `STORE.md` and its build, so making an extension and putting it in a store stays inside the MCP. It needs `projectPath`, parses the `## Listing` bullets (name, summary, description, category with per-store parentheses, support email, homepage, license, search terms), the privacy policy URL from the privacy section, and the Chrome single purpose and permission justifications, the Firefox reviewer and release notes and the Edge certification notes from the store sections, leaving `TODO` lines out; it takes the 128 px icon the built `dist/<browser>/manifest.json` declares and up to 5 `screenshots` (PNG paths inside `projectPath`, for example from `extension_screenshot`). Each store's change needs a workspace owner's approval, the same round trip as `extension_builds configure`: the first call answers `approval-required` with the approval URL and the change as the platform computed it, and a call with `browsers: [store]` and that `approvalId` writes it once, answering what changed and the listing checks still open (a privacy policy URL, screenshots when none were given). It counts as a shipping call in no-ship mode. `action: "preflight"` with `projectPath` now adds `storeMd` per store, naming which failing listing checks `STORE.md` and the built icon already cover ("title found in STORE.md, not yet in the console listing", "icon 128 px found in dist/chrome/icons/128.png, not yet in the listing") and which they do not, and the server instructions name the store step: STORE.md to listing to submit.
- `extension_project_create` and `extension_workspace_create` stop answering `creating` without end. A resume that kept getting the platform's 202 `CREATE_IN_PROGRESS` answered `creating, retryAfterSeconds: 10` on every call, for as long as the platform said so, while the project already existed. The tools now record when they first saw `creating` for a grant (in its `provisioning.json` entry), report `creatingForSeconds` and `startedAt` (the platform's `ageSeconds` and `startedAt` when it sends them), and once either passes 6 minutes answer `ok: false`, status `create-stuck`, code `E_CREATE_STUCK`, saying how long the platform has reported creating, that the project may already exist, and naming `extension_auth (action: login)` for it and its console page; `retryAfterSeconds` and the deviceCode stay in the answer for a client that keeps waiting. Before answering `creating` or `create-stuck`, `extension_project_create` reads whether the project exists with a stored login of the same workspace on the same server (whoami for the project's own login, the workspace's project list for another), and answers `created` and drops the held grant when it does. The `create-unconfirmed` hint says the platform may still be finishing and that a `creating` answer carries the platform's start time.
- `extension_build` and `extension_manifest_validate` no longer warn that `declarativeNetRequest` is missing from permissions when the manifest grants the namespace through `declarativeNetRequestWithHostAccess`. The permission scan accepted only the exact permission name, so a manifest with `"chromium:permissions": ["declarativeNetRequestWithHostAccess"]` (and the same under `firefox:permissions`) was told to add `"declarativeNetRequest"` for an API that works at runtime in both browsers. The scan now treats either grant as exposing `chrome.declarativeNetRequest`, names both in the warning when neither is declared, and says that `declarativeNetRequestFeedback` on its own only unlocks `getMatchedRules` and `onRuleMatchedDebug` next to one of them, since neither Chromium nor Firefox exposes the namespace on the feedback permission alone. The browser-prefixed keys were already read through the engine's per-browser view, so a grant that sits only under `chromium:permissions` still fails the Firefox build with the same per-target issue as before.
- `extension_submit` and the server instructions state the Firefox rule as the platform now ships it: with no saved release channel the upload is unlisted, always, never a channel inferred from AMO's current listing, and a saved channel is used as is. AMO is read only as a guard: an add-on AMO already lists, with no saved channel, is refused before upload with the instruction to save a release channel in the project's store settings, since an unlisted upload of a listed add-on would burn the version number, and the refusal holds while AMO cannot be read. 10.14.0 said Firefox kept the listed channel for an add-on AMO already lists. Chrome and Edge are unchanged: a draft that is not published and does not enter review.
- `extension_open` on Firefox reports a navigation the extension or the server redirected as `navigated`, the way Chromium does, instead of `navigation-unconfirmed` with `E_NAVIGATE_FAILED`. When the navigated tab shows a different url that still loaded (a `moz-extension://` page carrying the requested url, such as a declarativeNetRequest rule sending `.pdf` urls to the extension's own viewer, or another http(s) page), the answer is `ok: true` with `value.redirected: {from, to}`, the final url in `value.tab.url`, and a hint naming the redirect. A tab on the browser's error page, `about:blank`, or no url is still unconfirmed.
- `extension_eval {context: "background"}` on Chromium evaluates in the background the built manifest declares: the service worker on MV3, the background page on MV2. An MV3 extension whose worker had opened an offscreen document evaluated in that document (CDP type `background_page`), where `chrome.storage` is undefined, with only a warning that two background targets matched. The worker is now taken, or woken through `ServiceWorker.startWorker` when Chrome stopped it, and the answer says an offscreen document is also open and that `context: "page"` with its url evaluates in it.
- `extension_eval {context: "page", url}` keeps the url's `#fragment` when it picks the tab, on Firefox and on Chromium. Two extension tabs that differed only in the fragment (`pages/pdf.html#.../letter.pdf` and `#.../scan.pdf`) both matched `url: "pdf.html#.../letter.pdf"`, because the matcher dropped the fragment, and the call evaluated in whichever came first. A url with a fragment now matches only the tab that shows it, and a url that still matches tabs showing different pages is refused with `E_AMBIGUOUS_TARGET` (status `ambiguous-target`) listing their urls, where it used to evaluate in the first one. Identical copies of one page keep the earlier answer, the selected one with a warning. A url with no fragment matches as before.
- `extension_assert` `background-worker-booted` on Chromium counts only the target the manifest declares as the live background: a `service_worker` for `background.service_worker`, a `background_page` for `background.page` or `background.scripts`. An MV3 extension whose worker Chrome had stopped while its offscreen document (CDP type `background_page`) or a dedicated worker stayed open passed with that document or worker named as the booted background. It now reads as no live worker target and falls through to the log evidence and the inconclusive verdict a dormant worker gets.
- The link tools and the server instructions speak of two links by name. A build link opens one build and, on a private project, expires; a channel link always opens a channel's newest build and never expires. `extension_publish`, `extension_release_promote`, `extension_release_status`, `extension_shares`, the server instructions, `/extension`, `/extension-publish` and the shipped `CLAUDE.md` use both nouns, no longer call a private project's link a "public page", and make the advice conditional: on a public project, or a public channel, send the channel link. They also say a project's visibility is set in its extension.dev project settings, not its GitHub repository, and `extension_shares` says it lists emulator uploads, not build links.
- `extension_publish` answers the link to send and the sentence to say with it. `value.link` is `{kind: "build" | "channel", url, expiresAt, pointsAt, audience, scope}`, passed through from the platform, plus `renewBy` (the `extension_publish` call with `buildSha` and `ttlHours` that mints a fresh one) on a private project; on a platform that does not send `link` yet it is built from the older fields: a channel link when the project is public and a release channel serves the build, else a build link, with `expiresAt` converted from epoch seconds. `value.links` lists both kinds on a public project whose build a channel serves. `value.tellThem` (also in the hint) reads "Here is the build link for version 1.2.0. Anyone who has it can open it until October 6, 2026 at 12:00 UTC, and it always shows this build." on a private project and "Here is the channel link. It always opens the newest stable build." when a channel link exists. The top-level `expiresAt` is now an ISO date (it was the platform's epoch seconds, which the frozen fixture had wrongly written as ISO, so no test caught it), with `expiresAtEpoch` keeping the number, `ttlHoursRequested` and `clamped`, which says the platform cut a longer ask back to the plan's window. `value.projectVisibility` names its source, the extension.dev project settings, and on a private project `makeEvergreen`, the console Settings Visibility section, or the channel Audience control on the Releases page once it ships. A private project with no build to link answers `no-build-to-share` with the next step, where it answered `publish-failed`. The publish fixture now carries the platform's real shape (epoch seconds, `ttlHours`, `token`).
- `extension_builds` `create-channel` takes `audience` (`public` or `private`, checked before any request; left out, the platform uses the project's visibility) and sends it with the create. The platform does not take it at creation yet and sets the audience from the project's visibility, so when the channel it answers has another audience the answer warns and names the channel Audience control on the console Releases page, which only a workspace owner or admin can use. `extension_release_status` channel rows carry `audience` when `channels.json` records it, and its description says where a build link's validity is read today: the console Settings, Share links section. `ISO` joins the acronyms the description copy rules read as names.
- `extension_publish` no longer echoes the platform's raw share `token` in its answer: the token already rides in `shareUrl` and in each `previewCommands` entry, so the bare field only gave an agent a credential to paste somewhere else. The publish fixture keeps `token` in the platform's answer, and the envelope test now freezes that the tool's `value` has no `token` while `shareUrl` and `previewCommands` still carry it. The `publish-unconfirmed` hint stops sending the agent to `extension_shares`, which lists emulator uploads and never the build links publish mints, and names the console Settings, Share links section instead, with its URL when the project is known.

## 10.14.1

Built on Extension.js 4.1.33.

- `extension_wait {for: "rebuild"}` no longer takes the compile write itself for a reconnected background. The engine stamps `compiledAt` and `ts` with two clock reads around a synchronous read, so whenever they crossed a millisecond boundary the ready.json write that recorded the compile already satisfied the reattach proof (`runtime: "attached"` with `ts` past `compiledAt`), and the wait answered `reload.outcome: "reattached"` at `waitedMs` 0, before any reload or when none would ever follow (a content-only edit), and on an engine that stamps `reloadedAt` it preempted the wait for that stamp 10.14.0 promised. The two engines now get the proof that fits each: on an engine that writes `reloadedAt`, the reattach answer is never given, the reload stamp alone settles the wait; on an older engine, which has only the write sequence to go by, the reconnect must be a later ready.json write whose `ts` passes the `ts` the compile write itself carried, not merely `compiledAt`, so that write can never be its own proof. `reattached`, `still-detached` and `not-stamped` keep their meaning for the older engine.
- `extension_eval` with `until` keeps the whole call inside `timeoutMs`. Each poll ran with the call's own `timeout` (30000 by default) inside the engine's promise settle, and `until` checked its budget only between polls, so `until: {timeoutMs: 50000}` on a promise that never settles could run about 80 s, past the 60 s client request timeout the 50000 clamp exists for. Each poll's engine timeout is now the remaining `until` budget, with a 300 ms floor and a caller's smaller `timeout` still honored, so the call ends within `timeoutMs` plus one `intervalMs`.
- `extension_stop {browser}` leaves a dev server whose command line names no `--browser` alone unless chrome, the engine's default, is the browser being stopped. A person's own `npm run dev` beside an MCP firefox session on the same project read as that session's process, was SIGKILLed by `extension_stop {browser: "firefox"}` and listed under `reaped`. A command line with no browser flag now counts as the engine default's, so a firefox or chromium stop keeps it running and a chrome stop ends it.
- `extension_screenshot` writes its image only inside the project and only as a `.png`. `path` is resolved against `projectPath` and refused with `E_BAD_REQUEST` (status `bad-request`) when it lands outside it, by an absolute path or a `../` escape, or when it names a file that does not end in `.png`, so `path: "src/manifest.json"` no longer overwrites the manifest with image bytes. A folder is named with a trailing slash (`shots/`) or by an existing directory and gets the timestamped default name; a name such as `shots` that is neither a `.png` nor an existing folder is refused with a hint naming `shots/`, where it used to write a file literally called `shots`. The check runs before the browser is asked for pixels, the default location is unchanged, and the `path` description states the rules.

## 10.14.0

Built on Extension.js 4.1.33.

- `extension_submit` and the server instructions state each store's least public outcome as the platform now ships it, and no longer say submissions go to testers. Chrome and Edge upload a draft that is not published and does not enter review, even for an item that is already published. Firefox uses the unlisted channel for a new add-on or one with no listed version, keeps the listed channel for an add-on AMO already lists, and stops before uploading when AMO cannot say which. Safari stops at the TestFlight draft unless the call asks for Apple review. No store's API sets listing visibility, and a store that only uploaded is recorded as "Uploaded, not public", never as live, which the `submitted` answer now says too.
- On a public project, `extension_publish`, `extension_release_status` and `extension_release_promote` answer the link that follows a release channel, `<workspace>.extension.dev/<project>/channels/<channel>` (built with `userlandChannelUrl` from `@extension.dev/urls`), which always resolves to that channel's current build. `extension_publish` puts `value.channelUrl` beside the build page when a channel serves the published build (stable first), and says when none does; `extension_release_status` gives each channel row its `channelUrl`, per browser (`/channels/<browser>/<channel>`) for a channel promoted per browser; `extension_release_promote` answers the moved channel's `channelUrl` in place of `publicChannelUrl`. The descriptions and the server instructions say to send testers the channel link so they always get the newest build, and that the build page link pins one build. A private project, or one whose visibility could not be read, gets no channel link: `value.channelUrlWithheld` says why and names the `extension_publish` share link, and `extension_release_status` no longer lists a channel `publicUrl` for it.
- A tab the browser refuses to script is named as such. The engine now reports a refused injection as `InjectionRefused` (the CLI answers `E_COMMAND_UNSUPPORTED_FOR_TARGET`), and `extension_eval`, `extension_dom_snapshot` and `extension_inspect` answer it as `E_EXTENSION_PAGE_UNREACHABLE` when the tab shows an extension page, with the surface context to use instead, or as the new `E_PAGE_NOT_SCRIPTABLE` (status `page-not-scriptable`) for a browser page or a web page outside the extension's host access, with how to get host access or pick another tab. Neither is ever a missing target, and the Firefox debugger-protocol routes for extension pages still take either answer as their cue. The engine side needs Extension.js 4.1.34, not yet released: on 4.1.33 the engine answers such a refusal as a missing target, so the tools keep `E_TARGET_NOT_FOUND` with the generic hint that the tab could not be reached.
- `extension_wait {for: "rebuild"}` reads the reload stamp the engine now writes to ready.json (`reloadedAt`, `reloadKind`, `reloadLabel`). On an engine that writes it, a rebuild waits until both `compiledAt` and `reloadedAt` move past their values at call time (or past `since`) and answers `reload.outcome: "reloaded"` with `reloadKind` (`full`, `background`, `content`, `page` or `safari-resync`) and `reloadLabel`, so a content-script, page or Safari re-sync reload is confirmed instead of reported as `not-stamped`. An engine that writes no `reloadedAt` keeps the earlier answer: a brief watch for the background to reconnect, then `reattached`, `still-detached` or `not-stamped`. The stamp needs Extension.js 4.1.34, not yet released; a project on 4.1.33 gets that earlier answer.
- `extension_publish` takes `ttlHours` up to 8760 (365 days), where it refused anything past 168. A private project's share link defaults to 7 days, and a caller can ask for up to the workspace plan's share window (30 days on free, 365 on Pro); the platform cuts a longer ask back to the window and the answer carries the `expiresAt` it set. The description used to say the link defaulted to 24 hours. `extension_shares` and `extension_preview_web` take no lifetime.
- On a Firefox dev session, `extension_eval {context: "page"}` reaches a tab that shows the extension's own page on MV2 builds as well as MV3. A relative url such as `sidebar/index.html` (or its `moz-extension://` form) is now evaluated over the debugger protocol in the tab that shows it before the MV2 `tabs.executeScript` fallback runs, which answered "Missing host permission for the tab" first, so the protocol route never ran. With no `url`, when the active tab is an extension page, the same route evaluates it and a warning names the `url` and the surface `context` to pass next time. A web tab still takes `tabs.executeScript`, and when the session has no debugger port the refusal's hint names the page's url and the declared surface context.
- On Firefox, `extension_open {surface: "action"}` clicks a popup-less `browser_action` or `page_action`. The engine's replay covers `chrome.action` only and refused with "chrome.action not available", so the server now runs the browser's own toolbar action for the add-on (the path the `_execute_browser_action` shortcut takes) in Firefox's parent process over the debugger protocol, and answers `triggered` with `manifestKey`. In a headless run the listener's `sidebarAction.open()`, which Firefox allows only from user input, opened the sidebar. When that route cannot run, the answer is `action-not-replayed` (`E_ACTION_NOT_REPLAYED`), names the button the manifest declares and why the click did not run, and offers only routes that work (`surface: "sidebar"` when declared, `context: "background"`), not `asTab` or a headed restart. A manifest with `browser_action` used to read as "declares no action", which blamed the extension for the route's refusal, and `browser_action` and `page_action` popups now count as the action's popup.
- A `boot-failed` answer from `extension_dev` or `extension_start` now stops the session it started and says so (`value.sessionStopped`), so the hinted second call starts fresh instead of being refused with `E_SESSION_EXISTS`. A compiler failure outside a module (`compile_failed`, a plugin hook or `extension.config.js` that throws) leaves the engine's watcher unarmed, so fix-and-save could never recover it. When the stop fails, the hint names `extension_stop` or `replace: true`. `extension_doctor` no longer tells a session whose compile failed that its browser is still launching: the executor leg reads `skip`, blocked by runtime-errors, and both legs name the next call (`extension_wait {for: "rebuild"}` after a module error, `extension_dev` with `replace: true` after `compile_failed`). `extension_wait`'s `contract-error` answer carries the same hint.
- New `extension_screenshot` saves a .png of one open extension surface (popup, options, sidebar, newtab, history, bookmarks) or web page in a live session and answers its path and pixel size, so agents stop scripting `screencapture`, AppleScript or Playwright. It asks the browser for that page's own pixels over the session's debug port, never captures the screen and never brings a window forward: CDP `Page.captureScreenshot` on Chromium (`width` and `height` set the viewport, `deviceScaleFactor` the pixel ratio, and the page gets its own size back afterward), the debugger protocol's screenshot actor on Firefox for a page shown in a tab (`width` and `height` crop from the top left), and WebDriver on Safari for web pages, where an extension surface is refused with `E_SURFACE_NOT_CAPTURABLE`. The file goes under `dist/extension-js/<browser>/screenshots` unless `path` names a file or folder. A bare server now lists 24 local tools, 35 in all, and `extension_dom_snapshot` points to it for pixels.
- Engine text reaches the agent as plain text. Every answer is stripped of terminal escape sequences (colors, cursor moves, hyperlinks) where it is built, so a failed compile no longer arrives in `error.message`, `value.output` or an `extension_doctor` detail as the engine's colored frame, `\u001b[31m×\u001b[0m ...`, around the real line. `extension_wait` lists the compile error it reports in `value.errors`: the engine stamps a compiler failure outside a module (a plugin hook or `extension.config.js` that throws) with an empty `errors` and the cause in `message`, which used to answer `errors: []` beside it.
- `extension_analyze` answers the built manifest per browser. `value.manifestByBrowser` carries the emitted `manifest.json` of every browser built under `dist` (`emitted`), the resolved `background`, action key, sidebar key, `permissions`, `host_permissions`, `chrome_url_overrides` and `browser_specific_settings` of each (`resolved`), the names of those that differ between the browsers (`differences`), and per browser the source permissions or web accessible resources the build dropped (`sourceDivergence`). The `extension_build` hint names it, so comparing Chrome and Firefox no longer means reading `dist/<browser>/manifest.json` by script. The dropped-permission check behind `extension_build`'s warnings now reads `dist` at the engine's project root, so a manifest in a subfolder of a package is compared too.
- Every share, publish, deploy, distribute, release, ship, testers, link or store ask now leads with extension.dev. The server instructions depend on the options: with the platform tools on they route those asks to `extension_publish` first (the build's public page with a download and a run command for each browser, after `extension_project_create` and `extension_auth` when there is no project), with `extension_preview_web share:true` and `extension_shares` as the quick emulator link and `extension_submit` for stores, never a do-it-yourself route around the platform; local only, they say extension.dev does it and that `--features=local,platform` lists those tools. `extension_preview_web` leads with sharing, says content scripts run on the emulator's sample pages as a limit of the preview only, and names the Firefox view. `extension_publish`, `extension_shares` and `extension_submit` describe what a person gets, `extension_submit` says submissions default to the least public option each store allows unless the project's store settings say otherwise, every missing-login answer names `extension_project_create`, the `extension_build` hint names `extension_publish` when the platform is listed, and the held answer says extension.dev does that work once it opens. The `/extension` command gains a share action, and the shipped rules call the zip a store upload.
- The condition wait moved from `extension_wait` to `extension_eval`, so `extension_wait` is read-only again. `extension_eval` takes `until: {timeoutMs, intervalMs}` (pass `{}` for 30000 and 500): it repeats the eval until the value is truthy and answers `condition-met` with `value.result`, or `timeout` (`E_WAIT_TIMEOUT`) with `value.lastResult`, and it stops at once on a refusal polling cannot change, such as `eval-disabled`. `extension_wait` keeps `for: "rebuild"`, carries the read-only annotations again, and refuses a leftover `until` with `E_BAD_REQUEST` and a hint naming `extension_eval`, so a client that auto-approves read-only tools never runs code through it.
- `extension_wait` waits for more than readiness. `for: "rebuild"` waits for the compile after a source edit, until ready.json's `compiledAt` moves past its value at call time or past `since`, then briefly for the reloaded background to connect again, and answers `rebuilt` with the new `compiledAt`, `errors` and `reload.outcome` (`reattached`, `still-detached`, or `not-stamped` for a content-script, page or Safari app re-sync reload, which ready.json does not stamp), or `compile-error` with the errors. `until: {expression, context, url}` polls `extension_eval` every 500 ms until the value is truthy and answers `condition-met` with it, or `timeout` with `lastResult`. Both work on Chromium, Firefox and Safari sessions, and the hints say to call them instead of sleeping or tailing the session log. Since `until` runs an eval, `extension_wait` now carries the annotations `extension_eval` does (not read-only), so a client that auto-approves read-only tools still asks before it.
- `extension_wait` checks the browser before saying it is gone. A detached executor beside a live browser (the Safari automation session answering, or the browser pid the launcher recorded alive, including a relaunched Firefox after its first process exited) answers `ok: true`, status `background-asleep`, with how to wake the background: Safari and Firefox suspend a non-persistent background after 30 s idle, and Chrome an MV3 service worker. A Safari WebDriver session that Safari ended (someone interacted with the automation window) answers `webdriver-session-ended` with `E_WEBDRIVER_SESSION_ENDED` and the restart that opens a new one, in `extension_wait`, `extension_eval` and the `extension_doctor` safari-window leg. On Safari, `extension_eval {context: "page", url}` matches the window's page the way Firefox does (document, match pattern, then substring) and sends a host and port such as `127.0.0.1:8765` to `http://127.0.0.1:8765/` instead of passing it to safaridriver, which refused it with "Could not parse requested URL".
- `extension_dev` and `extension_start` take `headless`. `headless: false` opens a browser window the person can see, overriding `EXTENSION_HEADLESS` and any `--headless` in `EXTENSION_BROWSER_FLAGS` for that session only; `headless: true` forces headless; omitted, the session inherits the environment as before. Every answer that launches a browser reports `headless`, and a headless answer says the person cannot see the browser and how to open one they can. `extension_open` reads the session's own setting, so a visible session opened from a headless environment shows real popup, options and sidebar windows. A person who asked to see their extension used to be told it was open on their screen while it ran headless, and no tool input could change that.
- `extension_dev` and `extension_start` say when the browser profile already held state, by any route: the `profile` input, the profile a project's `extension.config.*` sets for that browser (resolved against the project), the managed persisted profile, or the folder the engine reports in `ready.profilePath`. Whether the folder held state is read before the browser launches, since the browser writes into it on start. Every answer that launches a browser carries `profileReused`, and a reused profile leads the warnings: the extension's `chrome.storage`, granted permissions and restored tabs come from an earlier run, so read `extension_storage` before acting on a toggle or a first-run assumption. A profile set in `extension.config.js` used to be reused with `warnings: []`, and an agent clicked a toggle that was already on.
- Next steps no longer hand the person a shell command. `extension_create` ends with asking "Want me to open it in Chrome so you can try it?" and calling `extension_dev` with `headless: false`, and moves the `npm run dev` line to `manualAlternative`, for use outside an agent. `extension_add_feature` ends the same way, and the server instructions tell every client to open the browser itself and never pass "run `npm run dev`" on as the person's step.
- `extension_start` takes `allowControl` and `allowEval` (eval implies control), so a production run can be driven with `extension_storage`, `extension_reload`, `extension_open`, `extension_dom_snapshot` and `extension_eval`. The browser loads a copy of the build with the control producer added; `dist/<browser>` keeps the shipped bytes. `extension_reload` reloads the installed extension under open tabs the way a store update does, so content scripts an update orphans can be tested without a hand-written debugging script. The answer carries `allowControl`, `allowEval` and `controlPort`, and once the extension's background connects to the channel the load reads as confirmed (`extensionLoaded: true`). An engine whose start verb has no `--allow-control` (the published 4.1.33) is refused as `engine-unsupported` with `E_ENGINE_TOO_OLD`, naming the flag and pointing to `extension_dev`, instead of a bare exit. The flags need Extension.js 4.1.34, not yet released; a project on 4.1.33 gets that refusal and drives the run with `extension_dev` instead.
- `extension_stop` with `browser` ends only that browser's session. A project can run a dev session for one browser and a production session for another, and stopping the second used to end the first too: the search for leftover processes matched every `extension dev`, `start` or `preview` command line for the project and every managed profile folder, whatever the browser, and listed the other session's server under `reaped`. It now leaves alone a command line that names another `--browser` and looks only in that browser's managed profile folder.
- `extension_eval` awaits a promise returned in a tab on every engine. With `context: "page"` or `"content"` through the in-tab executor (any Firefox tab, and a Chromium tab reached without CDP), the expression is wrapped so the tab settles the promise and this tool polls for the value, the way relay surfaces already did. Firefox used to fail with "result is non-structured-clonable data", reported as `E_TARGET_NOT_FOUND` although the tab was found, so an agent read a wait-then-check as the wrong tab. A result the browser cannot copy back now answers `E_EVAL_NOT_CLONEABLE`, saying to return a synchronous, cloneable value or use `context: "background"`, and the tool description says where promises are awaited.
- `extension_dev` runs one session per browser, not per project. A session for another browser now starts beside the live one, since each browser has its own `dist/<browser>`, `ready.json`, eval token, profile and port; a second session for the same browser is still refused, and the message now names that browser's output. `replace: true` stops only the session of the browser being replaced. The session tools that default `browser` to the live session (`extension_inspect`, `extension_wait`, `extension_eval`, `extension_storage`, `extension_reload`, `extension_open`, `extension_dom_snapshot`, `extension_list_extensions`, `extension_assert`, `extension_logs`, `extension_stop`, `extension_doctor`) answer `E_SESSION_AMBIGUOUS` (status `browser-required`) with the list of sessions when the project runs more than one, instead of picking the last one registered.
- On a Firefox `extension_start` session, `extension_eval` and `extension_dom_snapshot` reach the extension's own pages over the debugger protocol: a surface shown in a tab (`context: "options"`) and a page url (`options/index.html` or its `moz-extension://` form) are read from the tab that shows them, since the production build carries the control producer in its background only and script injection cannot enter a `moz-extension://` document. When the session records no debugger port, or no tab shows the page, the answer is `E_EXTENSION_PAGE_UNREACHABLE` naming `extension_dev`, never `E_TARGET_NOT_FOUND` for a page that may be open. `extension_open` confirms a Firefox options page from the debugger protocol's tab list. `extension_start` with `allowControl` no longer says the control verbs cannot attach while the contract has not recorded the control port yet, and no longer names the shipped `dist/<browser>` as the controlled copy; `extension_wait` on a production session with a control port says the verbs reach it once the background connects.
- `extension_start` keeps one session per browser on a project, the rule `extension_dev` keeps. A start for a browser that already runs a live dev or production session on the project is refused with `E_SESSION_EXISTS`, naming that session and `extension_stop` with its `browser`, instead of rebuilding `dist/<browser>` under the running session and overwriting its registry entry (the engine refuses only a second dev session). The new `replace: true` stops only that browser's session first and reports it as `replacedSession`; a session for another browser starts beside it untouched.

## 10.13.0

Built on Extension.js 4.1.33.

- The package exports `@extension.dev/mcp/hosted` for running the platform tools on a server. `registerHostedTools` adds them to an MCP server instance, and `createHostedServer` builds one. Both take a request credential: the caller's token, the platform base, and the projects that token covers. The hosted set is `extension_auth` (status only), `extension_workspace` (info, projects and settings), `extension_project_create` (one project per call), `extension_builds`, `extension_release_status` and `extension_release_promote`. Login, logout, publish, submit, share links and every local tool stay out of it. No hosted tool takes `api` or `projectPath`, and a call that passes one is refused before any request is sent.
- Under a request credential, the platform tools send that token and read no stored login, `EXTENSION_DEV_TOKEN` or `EXTENSION_DEV_PROJECT`. Writing or removing a stored login is refused, and nothing is written to the login store. The local server still reads `auth.json` as before.
- Under a request credential, every call to the platform names its project in the `x-extensiondev-project` header: the project the call passes as `project` when the credential covers it, else the first project it covers. One connected-app token can cover several projects, and the platform needs the header to know which one a call is for. A 401 from the platform during the call is reported to the host through `onUnauthorized`, so it can ask the client to sign in again.
- Under a request credential, `extension_auth` status describes the connection instead of a stored login: it names the project the connection's token is signed in to, and its warning says the connection renews on its own and can be revoked under the project's Settings, Connected apps. It no longer says that CLI tokens last 7 days or that CI must re-mint them.
- `extension_builds` with `action: "rebuild"` asks for a workspace owner's approval when the platform requires one, as it does for a rebuild started through a connected app: the first call answers `approval-required` with the approval URL and the exact commit and environment the platform resolved, and the same call with that `approvalId`, `buildId` set to the full commit sha and the same `buildEnv` starts the run once. A rebuild with an `approvalId` and a short or missing commit is refused before anything is sent. A used approval says the run may already exist and to read `action: "list"` first. A rebuild with a CLI login still starts at once.
- The project id that platform tools look up for a token is now cached under a hash of the server, the token and the project, never the token itself, and the cache keeps at most 512 entries.

## 10.12.0

Built on Extension.js 4.1.33.

- `extension_workspace` with `action: "settings"` points to `extension_builds` with `action: "configure"` for changing build settings. It used to say build commands change only in the console, so an agent asked to change one gave up.
- `extension_release_promote` and a real `extension_submit` say what the platform now asks of every call with a token: a promote needs a token minted by a workspace owner and a workspace owner's approval of that exact promote, and a real submission needs a workspace owner's approval of that exact submission. Both used to read as if the approval applied only while a platform setting was on. A promote refused because whoever approved it is not an owner says to request a fresh approval and have an owner approve it.
- `extension_release_promote` cuts a release with `action: "cut"`: it opens a pull request in the project's source repository that bumps the manifest version by `level` (`patch`, the default, `minor` or `major`) or to an exact `version`, optionally armed to release to `channel` when merged, with `releaseNotes` in its body. `action: "rollback"` returns `channel` to the build it served before. Both need a workspace owner's approval of the exact act: the first call runs the platform's checks and either refuses with the reason and the next step, asking nobody (`cut-refused`, `rollback-refused`, such as a channel the project does not declare or a channel with no earlier build), or answers `approval-required` with the approval URL and the platform's own description of the act; the same call with the `approvalId` then runs it once. A rollback's approval names the build the platform resolved, so a channel whose history moved before the approval is used refuses it. Cutting a release used to need the console.
- `extension_submit` withdraws a submission from review with `action: "cancel"` (`submissionId`, and `store`, default `chrome`) and raises the Chrome staged rollout with `action: "rollout"` (`deployPercentage`, a whole number from 1 to 100 above the current one, which Chrome does not let be lowered again). Both need a workspace owner's approval the same way, and a submission that is not in review or a project that does not stage its Chrome release is refused before anyone is asked, saying where to look or what to turn on. `action: "preflight"` reads each store's readiness for `browsers` (the failing checks with what to fix, and the warnings, never a secret value) and writes nothing. `cancel` and `rollout` count as shipping calls in no-ship mode; `preflight` does not.
- `extension_release_status` reads three more sections: `include: ["runs"]` the newest release workflow runs (the last 7 days, or `since` a date up to 30 days back, with a token minted by a workspace owner), `include: ["rollout"]` the Chrome staged rollout percentage and whether it can be raised, and `include: ["cut"]` whether a release pull request opened now could build after merging.
- The stores section of `extension_release_status` keeps the platform's `id` on each store's latest submission, which `action: "cancel"` takes. It was dropped from the latest submission while the earlier ones kept it.
- `extension_builds` with `action: "rebuild"` returns the run it started: `deploymentId` and `dispatchedAt`, and `runId` and `runUrl` once the platform found the run, with `follow.match` naming what to compare. A rebuild keeps the build id of the build before it, so the agent reads `action: "get"` and matches `runId`, or `deploymentId` or a `startedAt` after `dispatchedAt` while the run has not shown up. `action: "get"` names the run behind the build (`run`: `runId`, `runUrl`, `deploymentId`, `startedAt`), and `action: "list"` rows carry `runId`, `deploymentId` and `startedAt` when the platform has them. An agent polling a rebuild by its build id used to read the earlier, finished run as this one.
- A rebuild refused because only a person may replace what a live channel serves now says to ask a person on the project to replace it from the console, where releasing the commit offers Replace and rebuild. It used to point at the Builds page, which has no such control.
- An approval request uses the platform's own description of the act when the platform writes one, and asks the agent to call again with the same arguments and the `approvalId`. When an approval cannot be requested or verified, the answer calls the action irreversible only when it is (a promote, a store submission, a share revoke, a rollout raise); a build settings change used to read as irreversible.
- A login refused by a platform route that is closed to logins says which tool to use instead: a promote goes through `extension_release_promote`, a store submission through `extension_submit`, and deleting a release is a person's act in the console.
- `extension_builds` starts a rebuild with `action: "rebuild"`: `buildId` names the commit (the branch head when omitted) and `buildEnv` is `staging` (the default) or `production`. It dispatches a real CI run on the project's runners, counted against the workspace's build allowance, and answers at once with the commit, branch and browsers, plus the `list`, `get` and `logs` calls that follow the run. It never forces over artifacts a live channel serves: that refusal says which `buildEnv` the channel needs, and a burst or monthly cap says how many seconds the platform asks to wait.
- `extension_builds` changes build settings with `action: "configure"`. Pass only what changes, such as `{ firefox: { buildCommand: "pnpm build" } }`; the tool reads the current settings, merges the change and sends the whole set. A workspace owner approves that exact change first: the first call answers `approval-required` with the approval URL and the change as the platform computed it (`changes`), and a second call with the `approvalId` applies it once. A browser or field the settings do not have is refused before anything is sent, and a value the platform rejects is refused before any approval is requested.
- `extension_builds` adds a release channel with `action: "create-channel"` (`channel`, and optional `description` and `color`), answering with the project's channels; a channel that already exists reads as `exists`, not as a failure. `extension_release_promote` can then point it at a build.
- `extension_builds` is no longer marked read-only, since it now has these three actions; `list`, `get` and `logs` still only read, and `extension_workspace` and `extension_release_status` stay read-only.
- `extension_shares` shares a build the platform already made with `action: "create"`, `buildId` and `browser` (default `chrome`): it downloads that build's package from the registry of the server the call names, unpacks it in a temporary folder, and uploads it the way `extension_preview_web` with `share: true` uploads a local build, with the same allowance and no approval. An archive entry that would land outside that folder refuses the whole package before anything is written. Sharing a build used to need the project checked out and built on the same machine.
- Registry reads of a private project request their access grant through the `fetch` in effect at the time of the read. The grant request used the `fetch` present when the server loaded, so a host or test that replaced `fetch` afterwards still sent it to the real platform.
- Logins are stored per server. A login against a local or self-hosted server (through `api` or `EXTENSION_DEV_API_URL`) no longer replaces the production login for the same `<workspace>/<project>`, and a production login no longer replaces the local one. Every token-scoped tool uses the login minted on the server the call targets: `api`, else `EXTENSION_DEV_API_URL`, else production. `extension_auth` status reports the login for that server and lists every stored login with its server; logout removes only that server's logins. Logins stored by earlier versions are read as production logins unless they recorded another server. Signing in to a local copy of a workspace used to overwrite the production logins on the machine, so the next production call sent a local token and failed.
- `extension_project_create` with `projects` answers every call within about 45 seconds: it starts no new create 20 seconds into a call, polls a pending approval for at most 15 seconds, and abandons a create request still unanswered 45 seconds into the call, marking that project unconfirmed and never sending it again. `extension_project_create` with one `project` and `extension_workspace_create` abandon their create request at the same point. A list of ten could hold one call past the 60 second request timeout most MCP clients apply, and the agent got "MCP error -32001: Request timed out".
- A list's provisioning grant now outlives a server restart. Until it expires it is kept in `provisioning.json` beside the stored logins (readable only by the user, filed under the server and a hash of the device code, never logged), so calling `extension_project_create` again with the same `deviceCode` and arguments resumes the list with no second approval. The file entry is deleted when the list finishes or the grant expires. When a timed-out call left the client on a restarted server, the device code read "expired or already redeemed" and the projects not yet created needed a fresh approval.
- `extension_project_create` with one `project` and `extension_workspace_create` can learn the outcome of a create that outlived the call. When the create request goes unanswered, the grant is kept in `provisioning.json` the same way, and calling the tool again with the same `deviceCode` and arguments sends the same grant again: the platform answers `created` from its record of the first request when that request created it, `creating` while it is still running, and otherwise runs the create once more and answers with that outcome, so nothing is created twice. The entry is deleted once the outcome is known. A create the platform finished after 44 seconds used to answer `create-unconfirmed`, and finding out whether the project existed cost the user a second approval.
- Registry reads follow a local server. When the platform base (`api` or `EXTENSION_DEV_API_URL`) is a local server, `extension_release_status`, `extension_release_promote`, `extension_submit` and the other tools that read build and store data read that server's registry at `/api/local-registry` instead of `registry.extension.land`. `EXTENSION_DEV_REGISTRY_URL` still overrides it. Against a local server the agent used to read the production registry, which refused the local login with `bad-signature`, so it could not see a single build of a local project.
- A login is found under every name of the server it was made on. `localhost:3100`, `127.0.0.1:3100` and `www.extension.localhost` (where a local server sends people to approve) read the same local logins, and `https://extension.dev` reads the same logins as `https://www.extension.dev`. An agent that passed the approval page's host as `api` used to read `logged-out` with the login sitting under the other name.
- A promote, store submission or share revoke that the platform refuses before asking anyone to approve it now answers as that tool's own failure (`promote-failed`, `submit-failed`, `revoke-failed`) with the platform's code, and says no approval was requested. `extension_release_promote` refused for the build's environment also says how to get a build stable accepts: stable takes production builds, and no tool starts one, so rebuild the commit for production in the console, then promote it. `extension_submit` no longer calls an approval spent when the platform says it refused before consuming it. A stable promote of a staging build used to ask a human to approve it, then fail with `BUILD_ENV_MISMATCH` and leave the approval used.
- A promote, store submission or share revoke called with an approval that was already used no longer says "nothing was executed" without qualification. It says that call executed nothing, that the call which used the approval may already have run the action, and to read the state with `extension_release_status` or `extension_shares` before requesting a fresh approval. An agent that resent a used approval read the old wording as the action never having run, and reported a promotion as missing while stable was already serving it.
- `extension_release_status` with `include: ["stores"]` also reads the platform's own record of each store's latest submission and the store run it dispatched, using the stored login for that project (never a login for another project). Each store row carries `submissionRun` with the run's status, conclusion and URL, the step that failed, and whether any store step ran, and a run that ended before any store step is recorded as `failed` with the reason that no store received the submission. A run that died before writing to the registry used to leave the read `unavailable`, so the agent could not learn the submission had failed, and the platform kept reading it as `pending` for fourteen days.
- A tool's `api` now picks the registry and the stored login it reads, with no environment variable needed. `extension_release_status`, `extension_release_promote`, `extension_submit` and `extension_publish` called with `api: "http://localhost:3100"` read that server's registry at `/api/local-registry` and name the project from the login made on it. Before, only `EXTENSION_DEV_API_URL` moved the registry, so these calls read `registry.extension.land`, which refused the local login with `bad-signature`, and a call without `project` named the project of the production login.
- New `extension_builds` reads the platform's builds of the logged-in project with its stored login. `action: "list"` (the default) returns recent builds, newest first, with buildId, full sha, status, build environment, channel, browsers, createdAt, conclusion and the console page; `action: "get"` returns one build's details and validation checks, its artifacts, an integrity summary per browser and the usage report when one was recorded; `action: "logs"` returns the build's CI log lines per browser, a failed browser's job failure summarized, keeping the last 200 lines of a long log and saying how many it left out. The answer is fenced as untrusted data, because log lines are written by the project's own build. An agent could see a build's status from the registry but not why it failed.
- `extension_release_status` accepts `include: ["history"]` for the platform's release history: every release (browser and channel) with its build, version, rollout, promotion run and its 5 most recent events, plus whether a build is ready to promote, which needs a token minted by a workspace owner and otherwise says so instead of failing. `releaseId` reads one release with up to 20 of its events.
- The stores section of `extension_release_status` also reads each store's configuration from the platform when the login covers the project: enabled, configured, whether its credentials are set and the names of any that are missing (never a value), its listing URL and its submission mode, plus up to 5 earlier submissions per store besides the latest. A store's credential gap used to show only as a failed submission.
- A platform that is not open yet answers `extension_builds` and these new reads with the same `platform-held` envelope as the other platform tools, naming what still works on this machine.
- New `extension_workspace` reads the workspace a login belongs to, with any project login of that workspace on the server the call targets; there is no workspace token. `action: "info"` (the default) returns the workspace (role, members, project count) and its plan: limits, what is used this month and the refusals the plan made. `action: "projects"` lists every project with its browsers, release channels and last build per browser, and whether this machine holds a login for it. `action: "usage"` returns the billing period's CI minutes, runs and cost, in total and per project. `action: "settings"` returns one project's general settings and its build settings per browser, read with that project's own login. `workspace` names another workspace; a workspace with no login on this machine is refused before any request, naming the login to make. Plan and billing changes and members stay in the console, and the answer links there. The answer is fenced as untrusted data, because names, descriptions and build commands are written by people in the workspace.
- `extension_auth` signs in to every project of a workspace with one approval: `action: "login"` with `workspace` and `projects: "*"`. The approval page lists the projects the workspace has when it is opened, and the answer names each project signed in and stores its token. Only tokens for the requested workspace are stored; an answer naming a project of another workspace, or a project twice, stores nothing. A platform that does not advertise it is refused before a device code is spent. Signing in to a whole workspace used to need every project named by hand.
- A platform refusal of a login now names the next step. A login of another workspace says to log in to a project of that workspace (or all of them with `projects: "*"`), a login of another project says to log in to that project, a login whose approver left the workspace says to sign in again as a current member, and a read-only refusal points to the console. These used to read as a bare `refused`.

## 10.11.6

Built on Extension.js 4.1.33.

- `extension_start` and `extension_wait` read the load off the browser's debug port when the engine names one on the production contract (Extension.js 4.1.34 and later): a live `chrome-extension://<id>/` target sets `extensionLoaded: true` with the evidence, and a port that answers with no target of this extension leaves the load unread rather than calling it refused. An engine that names no port keeps the old answer. Agents used to report that they could not confirm the load.

## 10.11.5

Built on Extension.js 4.1.33.

- `extension_manifest_validate` reports `data_collection_permissions` the way AMO's linter does, measured against the bundled linter: a `strict_min_version` below 140 draws the unsupported-key warning, and 140 or 141 without `gecko_android.strict_min_version` 142 draws the Android one; no minimum at all draws nothing, so the tool stays quiet then too. Agents used to add the 140 rule from memory.

## 10.11.4

Built on Extension.js 4.1.33.

- `extension_manifest_validate` no longer tells a Firefox MV2 manifest to port `background.scripts` to `chromium:service_worker` when the manifest already declares one, nested under `background` or as a top-level `chromium:background`, and no longer asks for `chromium:action` when one is declared. A Firefox MV3 manifest whose only background is `background.scripts` now hears that Chromium MV3 runs only a service worker. The `newtab-react` template drew the port advice on every Firefox check.
- `extension_browsers` reports one version per browser, read from the binary itself: the bundle's `Info.plist` or `application.ini` first (the way the engine's `firefox-location2` reads it), then `--version`, keeping a prerelease suffix such as `a1`, `b3` or `esr`. `detect` used to cut Nightly's "159.0a1" to "159.0", and `list` reported no version at all, so an agent compared the cache folder `mac_arm-nightly_158.0a1` of a self-updated Nightly with "159.0" and called it a mismatch. `list` now carries `version` beside `binaryPath`, and the folder name stays only in the path.
- `extension_list_extensions` on Chromium lists every extension installed in the session profile, not only the ones with a live CDP target: an extension whose MV3 service worker has gone dormant is listed with `running: false` and no contexts, and live ones carry `running: true`. Component extensions (the PDF viewer) stay out. Agents used to warn that an idle extension "could be missing".
- `extension_storage` says when the project's source manifest does not declare the `storage` permission: the answer carries `manifestDeclaresStorage: false` and a warning that the dev session's control channel answered anyway while the extension's own code gets no `chrome.storage` without it. Agents used to guess why such a write worked.
- The plugin's CLAUDE.md template table lists `ai-chatgpt` under Sidebar beside `ai-claude`; it sat under Action popup, and every AI template is a side panel. The table placed it wrong, so agents listed it wrong.
- `extension_theme_verify` names steps a user can take for the two legs it cannot settle headless: open the theme in the editor at themes.extension.dev, and run it with `extension_dev` to look at the browser. It named two internal harnesses (`assert:theme`, `install-parity`) that exist only in the maintainers' repository, and agents read them out as next steps.
- `extension_analyze` lists every page the manifest declares as an entry point: `chrome_url_overrides` (new tab, history, bookmarks), `options_ui.page` and `options_page`, `side_panel.default_path`, `sidebar_action.default_panel` and `devtools_page`, beside the background and popup it already read. Agents asked what ended up in the bundle found only the service worker and reported the new tab page missing.
- CI runs all three required engine cells (`verify (canary)`, `verify (stable)`, `verify (floor)`) on every run, even when two resolve to the same version. It de-duplicated them by version, so with all three at 4.1.33 only `verify (canary)` ran, the other two required checks never reported, and every pull request read BLOCKED.
- `extension_theme_verify` calls a manifest with no `manifest_version` (and no Extension.js `chromium:manifest_version`) invalid: Chrome refuses to load any extension without it, themes included. It answered headless-clean, leaving agents to warn on their own that Chrome "may refuse" the theme.

## 10.11.3

Built on Extension.js 4.1.33.

- `extension_assert`'s `surface-rendered` check on `newtab` finds the override where Chrome lists it: an overridden new tab page is a `chrome://newtab/` target, not `chrome-extension://<id>/newtab.html`, so the check failed with "nothing is rendering it" while the page was on screen. A `chrome://newtab/` page counts only when it answers with this extension's own `chrome.runtime.id`, so Chrome's default page or another extension's override still fails. Agents running a plain "check that it works" failed on that and had to open the page by hand.

## 10.11.2

Built on Extension.js 4.1.33.

- `extension-create` and `extension-install` move from 4.1.32 to 4.1.33, the version `extension-develop` already ran on, so the nightly engine-pin check reads all three engines as current.
- CI runs the canary cell on stable when npm's canary tag is behind it (the tag sat on 4.1.31-canary while stable was 4.1.33), so a stale canary no longer reds the required `verify (canary)` check on a golden the pinned engine already changed.
- The generated tool reference moves from `claude/rules/mcp-tools.md` to `claude/reference/mcp-tools.md`. At 71k characters it restates the schemas the server already sends, and anyone who copied `claude/rules` into a project as Claude Code rules loaded it into every session; two such copies on one path (a workspace folder and a project in it) crossed Claude Code's 150k instruction limit and painted a warning naming the file. `claude/rules` now holds only the two hand-written rules, and a test keeps that folder under 10k characters.
- `extension_start` and `extension_wait` on a production session say what they read and never point at a file: the answer carries `browserPid` and `browserAlive` from the contract the launcher stamps, `extensionLoaded: null` with `loadEvidence` saying plainly that a production launch opens no debug port and carries no dev bridge (so `extension_logs` has no stream for it and the load itself is unread), and names `extension_dev` for a proven load; the `/var/folders/.../session.log` path left the answer. Agents used to show users that temp path and leave the load unproven.
- `extension_stop` says what it ended: the answer carries `serverGone`, the `browserPid` the launcher recorded in `ready.json` and `browserGone`, and its detail reads "Ended: the server (pid N) is gone; the browser the launcher recorded (pid M) is gone" (or that no browser pid was recorded, or that a build-only session launched none); a browser still alive keeps `stopped` false. Agents used to run `ps` to check the browser because the stop answer confirmed only the server.
- `extension_wait` answers with every port the session bound, read from the contract: `port` (the dev server), `controlPort` (the control channel) and `cdpPort` (the browser's debug port on Chromium) or `rdpPort` (on Gecko), or `debugPortNote` when the session opened none; `extension_dev`'s ready block inherits them. Agents asked for the ports could not name the CDP port, because it was in `ready.json` and in no answer.
- `extension_add_feature`'s description is the trigger: it names the asks it answers (add an options page, a popup, a side panel, a content script, a devtools panel, a new tab page or a background script), says it plans the surface and the agent writes what the plan says, and hands the follow-up to the manifest check and `extension_dev`. Agents used to hand-write the files without ever calling it. The README row and the plan's last step say the same.

## 10.11.1

Built on Extension.js 4.1.33.

- The engine pin moves from 4.1.32 to 4.1.33, the release whose bundled
  javascript template matches the examples corpus and whose eval ok golden
  answers the bare value the CLI answers (#834).
- The golden-frames test no longer records `golden.eval.ok.json` as the one
  golden that disagrees with the engine: 4.1.33 ships it with the bare value,
  so the file now goes through the same builder comparison as every other
  golden.

## 10.11.0

Built on Extension.js 4.1.32.

- The release workflow renders `docs/tools.json` and `docs/clients.json`
  right after it bumps the package version and commits them with the
  release: both files carry the version and the suite asserts the files on
  disk are the current rendering, so the first 10.11.0 run failed its own
  bump.
- The Safari automation hint names the setting the way the engine does: Safari > Settings > Developer > "Allow remote automation", with the Develop menu item on older Safari (Extension.js #836).

- `extension_dev` carries the control channel by default: `allowControl` defaults to true, so `extension_storage`, `extension_reload`, `extension_open` and `extension_dom_snapshot` work on a plain dev session and a later "reload it" costs no restart; pass `allowControl: false` for a read-only session. `allowEval` stays off until asked and still implies control. The descriptions, the hints, the docs gates, the README and the shipped rules say control is on unless asked off.
- `extension_wait` now says when it is needed (a session started with `wait: false`, a dev answer whose `ready.status` was not ready, a build-only session); `extension_dev`'s answer and the shipped rules say a ready answer ends the run recipe.
- `extension_docs_search`'s description is the trigger: any WebExtension API, manifest key, permission or browser-difference question is answered from the docs first, memory only when nothing matches.
- `extension_build` hands the reading of the output to `extension_analyze` in its hint, and `extension_create` says the scaffold needs no build to verify and names `extension_dev` as the next step.

- The `extension_logs` hint for a Safari session with no log file, the
  README, the rules and the `/extension debug` command name 4.1.21 as the
  Extension.js floor for Safari log streaming in place of 4.1.28, which no
  engine change backed (that number is the `navigate` verb's canary). The
  engine first streamed Safari background and content lines through the
  bridge in v4.1.20 (#533, the webkit background patch that stops Safari
  from skipping the MV3 worker), and v4.1.21 (#566) gave the dev-injected
  background of a project with no background of its own the same shape,
  so 4.1.21 is the first release where every project streams.
- `extension_build` always answers `outputPath`, the folder it checked the
  manifest in: the engine's reported path when the summary carries one, else
  `dist/<browser>` under the package root. On an engine older than the
  summaries contract the field used to be missing and an agent guessed the
  folder. `zipPath` stays beside it when a zip was asked for.
- `extension_create` answers `scripts`: every package.json script the
  scaffolder wrote that runs the engine, with the command, the browser it
  targets and the folder it writes (`npm run build` is flagless, so chromium
  into `dist/chromium`; `build:chrome` into `dist/chrome`; a monorepo
  script's folder is resolved under the package the engine builds). The
  `defaultsApplied.browser` sentence points at that list instead of
  restating it, and the description says to read the folder from there.
- `extension_project_create` defaults the build command to
  `npm run build -- --browser <browser>`, the browser's name per enabled
  browser, in place of `npm run build`: the platform runs the stored command
  as it is and reads `dist/<browser>` afterwards, and a flagless
  `extension build` writes `dist/chromium`, so a default-created project
  produced an empty artifact. `<browser>` in a command of your own is
  replaced the same way `outputDirectory` already did. The description and
  the `buildCommand` input say what the platform does with the command.
- The rules, the `/extension build` command and the `extension_build`,
  `extension_create` and `extension_project_create` descriptions now say
  what the engine does: `extension build` with no `--browser` targets
  chromium and writes `dist/chromium/`, so a scaffolded `npm run build`
  lands there, while `--browser=chrome` and `extension_build` (chrome by
  default) write `dist/chrome/`. The build rule tells the agent to read the
  folder from the build's answer (`outputPath`) instead of assuming
  `dist/chrome/`, which an agent did on 2026-10-08 and got `ls: exit 1`.
- The README and the `extension_create` description now say that a
  successful scaffold sends one `draft_seeded` event to PostHog, what it
  carries, and that `EXTENSION_DEV_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` turns
  it off. Nothing about what is sent changed; a test fails if either text
  stops naming the event or the two variables.
- The Live Preview carrier copy that `extension_dev {carrier: true}` places
  no longer admits `http://localhost/*` or `http://127.0.0.1/*` in its
  `externally_connectable`: on a stranger's machine those ports belong to
  whatever runs there. `EXTENSION_DEV_CARRIER_LOOPBACK=1` on the server
  keeps them for the extension.dev apps' own dev servers; the `carrier`
  description names the permissions the carrier holds and the switch.
- `extension_inspect` no longer sleeps 1.5 s after navigating or 0.5 s when
  it did not navigate: the CDP navigate already waits for the page's load
  event, so both waits read nothing.
- A CDP event listener that throws is reported on stderr with the event
  name instead of being discarded with unparseable frames, and the
  recorded console is kept.
- `extension_list_extensions` connects once to the port the ready contract
  stamped instead of retrying three times 800 ms apart: the port is read
  from a live session's contract, so a refused connection is the answer.
- One JSON frame reader (`src/lib/frame-json.ts`) replaces the two private
  copies in `extension_open` and `extension_eval`.

- The server starts with the local group alone: the 23 of its 32 tools that
  work on this machine. The 9 platform tools (account, share, release and
  store) come on with `--features=local,platform` or
  `EXTENSION_DEV_FEATURES=local,platform` while the platform is in private
  alpha. The Connect recipes name both groups for the two reaches that need
  the platform. The README moves signing in, sharing and the store lane
  under one Platform heading.
- `scripts/live-lane.mjs` drives the real server and the real pinned engine
  per browser, headless, through create, build, dev, wait, logs, list,
  open, dom snapshot, eval, storage, reload, assert and stop, and writes a
  verdict table. On 2026-10-07 it passed on Chrome, Edge, Firefox, Brave,
  Opera, Vivaldi, Yandex, Waterfox, Zen and Floorp. LibreWolf refuses to
  launch until its overrides file turns remote debugging on, so it is no
  longer listed as a dev browser (the `browser` enum still accepts it).
- The build test fixtures feed the engine's own `--output json` envelope on
  stdout and its narration on stderr instead of prose the engine never
  prints; the Safari webdriver seed names the 4.1.32 writer it copies; the
  Gecko assert cells run the real list-tabs reader on the engine's tab
  rows; `extension_reload` has its own test.
- The package lints with the console's rules: eslint-config-auditor's
  recommended and typescript presets, the house style plugin (blank lines
  between statements, curly, banner-aware header rules, no JSDoc prose),
  consistent type imports and the migration warnings, with the React and
  Tailwind layers left out. Every source file was reformatted by the fixer;
  no behavior changed.
- `extension_reload` of the background waits, bounded, for the engine's
  `ready.json` to stamp the executor detached and attached again, and
  reports `reattachedMs`, `detachedAt` and `attachedTs`; when the new
  background has not connected within the budget it answers `reloading`
  with a warning instead of `reloaded`. Before this the engine answered
  `reloading` 50 ms before the old background died, and a read landing in
  the detach-to-reattach gap (measured 11 to 129 ms on Zen and Floorp) got
  "the control channel did not answer". `extension_assert` names that gap
  when its Gecko read lands in it. Zen and Floorp pass the live lane 5 of 5.
- `@modelcontextprotocol/sdk` moves to 1.32.1, past GHSA-6qxp-vccf-f47h
  (the OAuth client paths it fixes are not used here). Its stdio reader now
  refuses a single client message over 10 MiB.
- Housekeeping: the July comment inventory left the repository, local
  audit folders and the package's own `.mcp.json` are ignored, and the
  template sync workflow commits with a plain sentence. The published
  tarball was checked file by file: only `dist`, `bin`, `claude`,
  `extensions`, the plugin manifests, `server.json` and the three top-level
  documents ship. The Extension.js pins already match npm's latest 4.1.32.
- Measured on this machine without a window: `extension_build` for Safari
  validates the manifest, generates the Xcode project and builds the app
  (31 s, bundle id derived from the app name). A Safari dev session and
  its surface reads still need Allow Remote Automation on and the
  extension enabled in Safari > Settings > Extensions, which are attended
  steps, so the live lane does not run Safari on its own.
- Measured on Extension.js 4.1.32: a Firefox MV3 event page answers
  `extension_eval` in `background` like an MV2 page does. The CSP refusal
  rewrite applies to a declared content_security_policy, never to MV3 as
  such.
- The envelope contract copied under the tests is the one Extension.js
  4.1.32 ships (it had stayed at the 4.0.17 bytes, so the byte comparison
  against the installed engine only warned), and the comparison now fails
  on any engine at or above the pinned release instead of only on an exact
  match. A new cell checks the build and doctor fixture builders key for
  key against the engine's golden frames.
- Test-only exports left the public surface: `reviewDist` (callers use
  `reviewDistReport`), `loginProjectRef`, `resolvedEngineVersion`
  (`resolvedEngineFacts` carries the version), the
  `HOLD_STILL_WORKS_SENTENCE` alias and the carrier registry's
  `rememberedCarriers`. A test-audit pass also removed cells that restated
  constants, pinned source spellings, or passed for a reason other than
  the one in their title, and fed the remaining hand-written frames from
  the engine's builders.
- No comments remain in the package beyond the file banner and tool-read
  directives. Every former invariant block is carried by a name, a cell
  title, or a `*-rules.test.ts` cell that fails when the rule is broken;
  each fixture builder names the engine or platform writer it copies, and
  a cell checks the engine markers against the installed engine. The 40
  browser, engine-internal and platform-server facts no code or cell can
  hold left the repository for the maintainers' notes.
- The invariant comments are cut to their rule: 509 blocks become 386 and
  3,744 lines become 2,814, with every ledger citation, date, commit, run
  id, first name and machine reference gone, the 120 that only restated a
  tested rule deleted, and five that no longer matched the code corrected
  (the build is an rslib bundle, the engine stamps the profile path, the
  Safari bundle id pattern is the engine's).
- The six inline `<workspace>/<project>` checks on login, project create
  and the create list now go through `isProjectRef`, so a ref with a space
  is refused where it enters instead of by the platform one call later. The
  login list keeps its own check because its exact-slug rule two lines down
  owns the message.
- Dead code out: `isManagedCarrier`, `credentialProjectRef`, `mirrorActionsUrlFromRunUrl`,
  `browserExitStamp`, `hasSourceMaps`, `REGISTRY_BASE_DEFAULT`,
  `SAFARI_MCP_ADD_COMMAND`, `BrowserType`, `ASSERT_RETIRED_IDS`, two unused
  `vi` imports and the live lane's unused `GECKO` set.
- The lint migration warnings no longer re-enable core `no-unused-vars`
  after typescript-eslint turned it off; `@typescript-eslint/no-unused-vars`
  stays. The same line left the monorepo's shared config.
- Nine test files write `ready.json` through the engine contract builder
  instead of by hand; the stop-hints cells name the dead server pid they
  cut in.
- Sleeps go through `node:timers/promises`; one JSON object reader serves
  login config and the approval gate; `consoleBase` and `consoleProjectUrl`
  moved to `src/lib/console-urls.ts`, which ends the login-flow, registry,
  registry-access import cycle; four shadowed names renamed; the
  platform-hold header read lost a catch nothing could reach.
- Five exports that existed only for tests are gone: `getSession`,
  `resetEngineVersionCache`, `resetSessionIdentityForTests`,
  `resetBatchCreateSessions` and `uninstallCarrierExitCleanup`. The cells
  that used them now read the in-memory registry through `listSessions`,
  or start a fresh module graph per cell, which is what "a new process"
  meant in those cells all along.
- The eval envelope has fixture builders in both shapes, and the golden
  frame cell now compares nine of the engine's twelve golden files key for
  key and names the three without a counterpart. The detect sentences are
  a pure function, so the not-found cell no longer runs a 20 s scan; the
  tool description rules are five tables instead of 160 cells.
- The manifest is trimmed: the 20 `pnpm.overrides` floors from the
  September advisory sweep are gone (the tree resolves past every one of
  them now, and the audit reads the same with or without them),
  `browser-extension-manifest-fields`, `vite`, `@eslint/js` and
  `typescript-eslint` leave the dependencies (nothing imported them), and
  the `clean`, `watch`, `start`, `build` and npm hook scripts leave
  (nothing called them; the release lane publishes with scripts ignored).
- Thirteen test cells that hand-wrote the CLI eval or target-not-found
  envelope now feed the fixture builders; one cell pinned `E_NO_SESSION`,
  a code the engine never sends, and now asserts the engine's
  `E_SESSION_NOT_FOUND`. The engine's own `golden.eval.ok.json` wraps the
  value as `{ result, context }` while its executor and CLI answer the bare
  value; the eval builder follows the engine and a cell names the
  disagreement until upstream settles it.
- The Live Preview carrier leaves the package: the bundled extension under
  `extensions/`, the `carrier` input on `extension_dev` and the loopback
  switch are gone. The carrier only ever reached a machine through this
  package, and with the platform in private alpha there is no public
  delivery for it, so the public package no longer ships a companion that
  holds `<all_urls>`, cookies, history, bookmarks and scripting. A copy an
  earlier server placed is still taken back on `extension_stop`,
  `extension_start` and `extension_build`, and a build that packs one is
  still refused.

## 10.10.13

Built on Extension.js 4.1.32. It closes the last findings of the 2026-10-05
audits.

- Safari dev sessions: Extension.js 4.1.32 opens a `safaridriver` session
  and records it in `ready.json`, which is what this server's Safari page
  reads were built on. When the engine could not open one, the hint and
  `extension_doctor` now relay the engine's own reason (Allow Remote
  Automation off, `safaridriver --enable` not run) instead of saying no
  release opens a session.
- The engine pins move to 4.1.32. Its Vue pin is now 3.5.43, so installs no
  longer carry the `@vue/server-renderer` advisory.
- Windows: a session-state folder that is a file, or sits under one, is
  reported as unreadable instead of as "no sessions", for both session
  markers and Live Preview carriers.
- The test suite runs on Windows on every push.

## 10.10.12

- `extension_stop` on Windows reads the Windows process table to find what
  is left of a session, so a stop that ended the whole tree says
  `stopped` instead of "survivors were not verified". Before this, every
  Windows stop answered `stopped: false`, and `extension_dev` with
  `replace: true` refused every time. A stop still says unverified when
  the table cannot be read. Measured on a Windows runner.
- The lockfile raises `proxy-addr`, `source-map-js` and Vue past their
  open advisories.

## 10.10.11

The rest of the 2026-10-05 audit findings, apart from the Safari WebDriver
fields that wait on the engine.

- `extension_eval` says where it ran and what came back: the tab's url and
  title on Firefox, a note when the value was not serializable, only real
  background targets as the background, and `eval-lost` or
  `eval-unsupported` when the answer never arrived. A woken worker is no
  longer said to have idled when it may never have started.
- `extension_logs` and `extension_assert` report a cut stream: a follow
  that closed early is a partial read, dropped-line markers are not
  counted as events, and console-errors-empty is inconclusive when lines
  were dropped. An unknown console `context` is refused as a bad request
  instead of failing the whole call.
- `extension_wait` and `extension_start` report only what they observed:
  a start session is `build-ready`, a build contract or a stopped session
  is `no-session`, and start refuses Safari and preview-path hosts it
  cannot serve.
- `extension_open` names the DevTools panel frame that appeared, and says
  when the panel registry could not be read or the target was inferred.
- Platform answers of the wrong shape (channels, build index, shares,
  login config) are unreadable, never empty, and an unpinned publish
  matches the build the platform named.
- `extension_stop` counts a process as reaped only once it is gone, and
  ends a Windows session through `taskkill /T /F`. A session marker that
  could not be written is a warning on the started answer, and the
  `release promote` command exits non-zero on an answer it cannot read.
- `extension_list_extensions` on Firefox marks a lone temporary add-on as
  an inferred match.
- The scheduled test tier builds through the real pinned engine with
  `--output json` and checks the fixtures against what it writes.

## 10.10.10

Every sentence the server says is now backed by something it read
(two audits of 2026-10-05: a claims
census of about 2,030 sentences and a fixture sweep against the pinned
engine and the platform).

- Success is read, never assumed. Promote, submit, publish, project and
  workspace create, logout and uninstall read the platform's or the
  library's own answer and say `promoted-partially`, `submit-unconfirmed`,
  `publish-unconfirmed`, `create-unconfirmed`, `not-installed` and the like
  when it falls short. A failed read is reported as unreadable, never as an
  empty list, across eval, open, the tab polls, session markers and
  carriers.
- One resolver returns the token and the project it belongs to. An
  unnamed call sends `EXTENSION_DEV_TOKEN` and takes its project from the
  token's own claims, never from whichever stored login is active; a named
  project sends its stored login first, the private registry grant
  included.
- `extension_manifest_validate` judges each browser through the engine's
  own prefix filter, checks every requested browser's references, refuses
  an unknown target, and blocks only where the engine or the browser
  refuses (a `service_worker` the engine rewrites for Firefox is a
  warning).
- `extension_build` reads `zip_artifacts`, refuses a stale dist, reports a
  timeout as `build-timeout`, uses the engine's own bundle-id rule, and
  writes `firefox-based` builds where the engine does (`dist/gecko-based`).
- `extension_inspect` names the document it read after navigating, counts
  uncaught exceptions as console errors, reports a section that threw as
  `failedSections` instead of an empty value, and marks every cap.
- `extension_open` checks popup, options and sidebar against the manifest
  before asking the engine, says when an open could not be confirmed, and
  never counts a tab it rendered itself as the window.
- `extension_storage` reads a set back; `context` is gone, since the engine
  runs every storage call in the background.
- `extension_assert` counts only the extension's own log lines, reads the
  guest's id from the contract, compares storage values structurally, and
  does not credit a background the dev build injected.
- `extension_stop` with `all` leaves sessions owned by another running
  server alone unless `includeOtherServers` is true; stop and auth are
  marked destructive.
- `extension_dev` reports the control channel from `ready.json`, and a boot
  error that is not a compile error answers `boot-failed`.
- The tool reference `claude/rules/mcp-tools.md` is generated from the
  schemas, and a test validates every example call in the docs against
  them.
- Requires Node 22.12 or later, the floor of the engine this package runs
  in-process.
- The release workflow publishes to npm before it pushes the version
  commit and tag, so a failed publish no longer strands a tag.

## 10.10.9

- One approval now covers several projects in one workspace. Onboarding ten projects used to cost
  twenty visits to extension.dev/device, one to create each project and
  one to sign in to it, and the ten tokens then expired together and cost
  ten more. This release is the client half and waits on the platform
  deploy that accepts a list. The platform advertises the capability as
  `batchOnboarding` in its login config; against a platform that does
  not, both inputs below refuse the list before a device code is spent
  and name the one-project call to use instead.
- `extension_project_create` takes `projects`, a list of
  `{ project, repo }` entries in one workspace, in place of `project` and
  `repo`. The approval page lists every name. Each project is created by
  its own request and its 7-day token is stored as that project's login,
  so no `extension_auth` call follows. An entry may carry its own
  `displayName`, `description`, `installCommand`, `buildCommand`,
  `outputDirectory`, `browsers` and `outputDirectories`; the same inputs
  at the top level are the default for entries that leave them out.
- The answer has one row per project: created and logged in, created
  with no token (the hint names the batch login to run), refused with the
  platform's own code, unconfirmed when a request got no answer, or not
  attempted. A refusal about one project (a name taken, a reserved slug)
  does not stop the list. A refusal about the approval (an expired grant,
  the hourly limit, the plan's project limit, a missing GitHub App
  installation) stops it, and every project not reached still gets a row
  saying so.
- A list takes a few calls: creating a project is slow, so while
  projects remain the answer is `status: "creating"` with the same
  `deviceCode` to call again. The provisioning grant is held in the
  server's memory for its 15 minutes and is never written to disk or
  returned; if the server restarts mid-list the projects already created
  stay created and the rest need a new approval.
- One approval creates at most 10 projects, because the platform creates
  at most 10 per hour for one approving account; the next 10 can start
  in a new call once that limit allows. The cap is read from the
  platform's login config (`createProjectsPerApproval`), with 10 as the
  fallback when the platform states no usable number. A longer create
  list is refused before any approval is asked for, with that reason; it
  is never split silently.
- `extension_auth` with `action: "login"` takes `projects`, a list of up
  to 20 `<workspace>/<project>` names of existing projects in one
  workspace (the platform's `loginProjectsPerApproval`), in place of
  `project`. One approval stores one token per
  project, which is also how a set of logins that expire together is
  renewed. One missing project refuses the whole list and stores
  nothing. The call that completes a batch login can take up to a
  minute.
- Both lists are checked before a device code is spent, by the
  platform's own rules: one workspace, 1 to 20 names, no name twice, and
  each project by its exact slug (lowercase letters and digits joined by
  single dashes, at most 48 characters). The refusal names the entry.
- A batch login or create does not change which login is the default.
  A single login still does.
- A server started with `--project` refuses a list that names any other
  project, the same refusal a single call gets, and takes a list of the
  pinned project alone. A list on `logout` or `status` is refused rather
  than ignored.
- `extension_project_create` no longer lists `project` and `repo` as
  required in its schema, since a list replaces them. A call with
  neither form is still refused, by the tool.
- `extension_publish` with `project` now describes the project it was
  called for. The token was already picked
  by `project`, but `registryUrl`, and the build index behind a missing
  `buildSha`, `version` or `builtAt`, came from the most recent login, so
  with several logins stored a publish for one project could return
  another project's registry address and fill its build details from
  another project's builds. The same slip is fixed in
  `extension_release_promote` (the builds page, the channel list and the
  public URLs it returns) and in the `extension_submit` dry run (the
  console page it names). `extension_shares` and `extension_preview_web`
  were checked and did not have it.
- A private project's registry data is read with the login stored for
  that project. It used to be asked with the most recent login, which
  gave up on a mismatch and reported the builds as missing.
- `extension_release_status` reads a `project` given as
  `<workspace>/<project>`, the form every other tool takes. It used to
  join the pair to the active login's workspace and ask the registry for
  an address that names no project, which is also what a server started
  with `--project` sent on every call.

## 10.10.8

- On Firefox, `extension_eval` now reads an extension whose content
  security policy forbids eval, which is every MV3 extension page. Extension.js 4.1.31 evaluates such a
  document over the debugger protocol, but the wrapper this server put
  around a popup, options, sidebar or override-page expression called
  eval itself, so those contexts still answered "blocked by CSP" on an
  engine that could read them. A refused surface is now asked again with
  the bare expression, which the engine takes over the protocol and
  awaits there. A project pinned below 4.1.31 keeps the refusal, and its
  hint now names that floor.
- `extension_eval` with `context: "page"` and a `moz-extension://` url
  reaches a page the manifest declares as no surface (`pages/*`), through
  the console actor of the tab showing it. It used to answer
  `E_NO_SURFACE_DOCUMENT`. Open the page with `extension_open` first; a
  page no tab shows answers `E_NO_MATCHING_TARGET`.
- `extension_dom_snapshot` on a `moz-extension://` url reads the page the
  same way when Firefox refuses the injection with "Missing host
  permission for the tab", and returns the engine's own snapshot fields.
- `extension_eval` with `context: "page"` on a site whose policy forbids
  eval now works on an MV3 Firefox build, over the debugger protocol,
  when `url` names the tab. An MV2 build keeps its `tabs.executeScript`
  route, which had gone dead on Extension.js 4.1.31 because that engine
  renamed the refusal to `E_CSP_BLOCKS_EVAL`; both spellings are read now.
- The protocol takes one expression. A statement list sent to a
  policy-locked Firefox document answers `E_BAD_REQUEST` with the way to
  wrap it, where the background used to answer a control-channel error
  carrying "SyntaxError: expected expression".
- Still refused, by name: a string evaluated in the content-script world
  of an extension whose policy forbids eval. Use `context: "page"` or
  `extension_dom_snapshot` there.

- `extension_submit` and `extension_release_status` (include: ["stores"]) link to the console's
  Submissions tab at `/<workspace>/<project>/submissions`, where the page
  moved; the old `/stores` address still redirects. `@extension.dev/urls`
  moves to `^0.8.2`, which carries the new paths.

## 10.10.7

- A share revoke now waits for a person by default, like a real store
  submission and a promotion to stable: the first `extension_shares`
  revoke answers `approval-required` with a link, and the same call with
  the returned `approvalId` runs it once. A revoke cannot be undone, so
  it is the one outward call that should never run on an agent's word
  alone. `EXTENSION_DEV_APPROVAL_GATE=0` still turns the gate off.
- New tool `extension_docs_search`: keyword search over the Extension.js
  and extension.dev docs, returning up to 8 pages with a title, URL and
  an excerpt of at most 400 characters. It calls
  `/api/docs/search` on extension.dev, which ranks with no model call, so
  it is free, needs no login and is in the `local` group. Its
  description is kept short on purpose so it costs little context.

## 10.10.6

- Tools that read a page or an extension (`extension_logs`,
  `extension_dom_snapshot`, `extension_inspect`, `extension_eval`,
  `extension_storage`, `extension_open`, `extension_assert`,
  `extension_reload`, `extension_wait`, `extension_doctor`,
  `extension_list_extensions`) now fence what it wrote between
  `<untrusted-data-ID>` and `</untrusted-data-ID>`, with a fresh random
  `ID` per call named in `untrusted.boundary`, so text on an inspected
  page that says to publish or revoke reads as data, not as an
  instruction. The fence covers `value`, `error`, `warnings` and `hint`,
  because page text also reaches error messages and hints. A tag the
  page writes, even one that guesses the ID, is escaped in the raw text
  and parses back to the same characters, so every answer is still one
  JSON envelope with the same fields. Build, analyze and dev output stay
  unfenced: they carry the project's own source.

## 10.10.5

- `extension_build` and `extension_analyze` report store review risks
  read off the built package, as `value.reviewRisks` plus one warning
  each with the fix: access to every website, code the package did not
  ship (`eval`, `new Function`, scripts or imports loaded from a URL), a
  Firefox manifest without `data_collection_permissions`, and API
  permissions no shipped script uses. They never block a build. On a
  dev build only the manifest checks run, because the hot-reload runtime
  and the injected `management` permission are not what a store
  receives (measured on seven published extensions' dev builds against a
  production build of an official template).

- The bundled `/extension-publish` command now takes an extension through
  store review with this server's own tools instead of sending people to
  the store consoles by hand: it validates, builds, checks for review
  risks, rehearses with `extension_submit` (dry run), and submits only on
  the user's yes through the approval link. It covers Chrome, Firefox,
  Edge and Safari, and keeps whatever manifest version the project
  declares rather than migrating it during a submission.

## 10.10.4

- `--project <workspace>/<project>` (env `EXTENSION_DEV_PROJECT`) pins a
  server to one project. Every unnamed credential read takes that
  project's login instead of the most recent one, an agent signed in to
  several projects can no longer act on the wrong one, and a call that
  names a different project is refused with `status: "project-pinned"`.
  A pinned project with no stored login falls back to
  `EXTENSION_DEV_TOKEN`, so CI keeps working.
- New `@extension.dev/mcp/clients` export: `CLIENTS` and
  `buildRecipe({ client, reach, strictApproval, project })` build the
  exact setup for Claude Code, Cursor, VS Code, Codex and any
  `mcpServers` client. The README's Setup section is generated from it
  (`pnpm readme:clients`, checked by a spec), and the extension.dev
  console's Connect dialog renders the same recipes, so the instructions
  cannot drift. It never emits a setting that turns approvals off.

## 10.10.3

- The engine pin moves off the canary to Extension.js `4.1.31` stable:
  `extension_dev`, `extension_start` and `extension_build` spawn that
  release when a project has no engine of its own, and the nightly
  engine-pin check reads it against `latest` again.

- A human now approves a real store submission and a promotion to stable
  before either runs, by default. The first call answers
  `approval-required` with an `approvalUrl` on extension.dev
  (`/device/approve/<id>`) and an `approvalId`; once a workspace member
  approves (an owner, for a submission), the same call with that
  `approvalId` runs exactly that action, once. Promotions to other channels
  and share revokes stay ungated unless `EXTENSION_DEV_APPROVAL_GATE=1`;
  `EXTENSION_DEV_APPROVAL_GATE=0` turns the default off. Whatever the
  setting, a platform that answers `APPROVAL_REQUIRED` now gets the same
  approval flow instead of a bare failure.

- Two server flags narrow what an agent can reach. `--features=local`
  or `--features=platform` (env `EXTENSION_DEV_FEATURES`) lists one tool
  group; `local` alone is about 40% smaller. `--no-ship` (env
  `EXTENSION_DEV_NO_SHIP`) hides `extension_publish` and
  `extension_release_promote` and refuses a real submit, a share link and
  a share revoke, while dry runs and listing keep working. A refused call
  answers the new code `E_TOOL_DISABLED` with the flag to change. Both
  default to everything on, so no existing setup changes.
- Every tool now carries MCP annotations (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) from one policy
  table, so clients can auto-approve reads and ask before the rest. A
  merged tool takes its worst action: `extension_shares` is destructive
  because revoke is.
- A device-flow step waiting on a human (`extension_auth` login,
  `extension_project_create`, `extension_workspace_create`) now answers
  `ok: true` with `status: "authorization-pending"` and no error, instead
  of `ok: false` with `E_AUTH_PENDING`, so clients stop rendering the
  first login step as a failure. The approval link and code stay in
  `hint` and `value`; `E_AUTH_PENDING` is retired.

## 10.10.2

- The engine pin moves to the Extension.js canary
  `4.1.31-canary.1791055414.4bbb683a` (chosen 2026-10-01, refreshed
  2026-10-03 when the canary moved on): `extension_dev`,
  `extension_start` and `extension_build` spawn that build when a project
  has no engine of its own, and the nightly engine-pin check now reads a
  canary pin against the canary dist-tag instead of latest. The canary's
  log query treats level `off` as none (it was a synonym for all), which
  changes nothing for `extension_logs`, whose `off` stays "signals only".
  The canary also adopts a project root only when it owns the manifest
  (same folder, the `src/manifest.json` layout, a dependency on
  Extension.js, or an `extension.config.*` beside it) and otherwise builds
  into the manifest's own folder; the session artifact resolver here
  applies the same four tests, so `extension_wait` and `extension_logs`
  keep reading the ready.json the engine writes.
- Logins to several projects now live side by side in `auth.json`, one
  entry per workspace/project with the latest marked active, instead of
  one slot the next login overwrote. `extension_publish`,
  `extension_release_promote`, `extension_submit`, `extension_shares` and
  `extension_preview_web` take `project` ('<workspace>/<project>', or a
  project slug that matches one login) to pick a stored login, which
  outranks `EXTENSION_DEV_TOKEN`; omitted, the order stays environment
  first, then the active login. `extension_auth` status lists every login
  under `logins`, and logout with `project` removes just that one. A
  version 1 file is read as a store of one and rewritten on the next login.
- Four findings from a six-browser sweep: `extension_open` reads new headless off the `User-Agent` field
  of `/json/version` as well (`--headless=new` keeps `Chrome/151` in the
  `Browser` field) and, whatever the launch flags said, falls back to the
  tab route on any window refusal: Chromium's gesture refusal for a popup,
  an options or popup window the engine called opened but no document
  appeared for within 3 s, and Gecko's "Popup is disabled"; a Gecko
  browser that gets Chromium's gesture sentence (the engine counts every
  non-Firefox name as
  Chromium) is answered with
  Gecko wording; and when the background refuses the `runtime.getURL` eval
  the tab route needs (an extension CSP that forbids eval), the
  `moz-extension://` base is read off the profile's
  `extensions.webextensions.uuids` pref through the add-on id the built
  manifest declares, so the fallback still lands. `extension_eval` context `background` wakes an idle
  MV3 worker through `ServiceWorker.startWorker` from a page session
  before evaluating, with a warning that it was idle, instead of answering
  `E_NO_TARGET`. `extension_open surface: "devtools"` takes `waitMs`
  and `reload` (reload the inspected tab once DevTools is open, for
  extensions that create their panel when the page reports to them) and
  the missing-panel hint names both. A page eval the PAGE's CSP
  refuses on a Gecko MV2 build is re-run through `tabs.executeScript`, the
  same wrapper the no-scripting-API case uses; an MV3 Gecko build
  keeps the policy explanation, pending an engine fix.
- `extension_eval` over CDP awaits a promise-valued expression again. The
  CDP routes added for the background and url
  reads passed `replMode` on every
  `Runtime.evaluate`, and Chrome 151 answers a replMode evaluate with the
  promise object itself, ignoring `awaitPromise`, so `Promise.resolve(42)`,
  an async IIFE or `chrome.tabs.query({}).then(...)` read as `{}` with
  `ok: true` on pages and workers alike. The evaluate now runs without
  replMode, and only an expression Chrome refuses for a top-level `await`
  is re-run in replMode with the promise settled through
  `Runtime.awaitPromise` (a regression of
  10.10.2's own, never released).
- `extension_open` takes `surface: "devtools"` on Chromium: it opens the
  browser's real DevTools on a tab (the one `url` matches, else the first
  web page) through CDP `Target.openDevTools`, waits for the extension's
  `devtools_page` to register its panel, shows it (`panel` picks a title
  when there are several) and hands back the panel document's url, which
  `extension_eval` reads with context `page` and that url, with
  `chrome.devtools` available. Context `devtools` on `extension_eval` now
  evaluates over CDP on an MV3 session like the other surfaces, and an
  extension document lookup matches the iframe targets a DevTools panel
  and its devtools page are. Works headed or headless (measured Chrome
  151). Gecko gets a refusal that says no protocol opens its developer
  tools.
- `zen` and `floorp` join the browser enum of `extension_dev`,
  `extension_start` and friends, the Gecko family, `extension_browsers`
  detection (app bundles, Linux and Windows paths) and the process match
  `extension_stop` uses, the same way waterfox is listed; the engine has
  launched both since 4.1.26.
- The dependency floors move past every advisory `pnpm audit` reported on
  2026-09-30 (42: 18 high, 22 moderate, 2 low, all transitive): axios,
  brace-expansion, fast-uri, js-yaml, nanoid, devalue, hono, ip-address,
  qs and postcss-selector-parser through `pnpm.overrides`, vitest to 4.1.11
  as a dev dependency. The audit reads zero; nothing the server does
  changes.
- The bundled template catalog moves to the corpus at `2c3a486a`, which
  renamed the `new-*` examples to `newtab-*` and added the `devtools-*`
  family and `sidebar-monorepo-nx`. `extension_add_feature`'s newtab row
  now names `newtab`, `newtab-react`, `newtab-vue`, `newtab-svelte` and
  `newtab-preact`; the catalog-sync PR had failed on the old names every
  day since 2026-09-26.

Findings from a session that brought ten third-party extensions under the
server in one day:

- `extension_dev` and `extension_start` spawn the engine in the project
  directory, not where the MCP client started the server, so the engine a
  session drives is the project's own and the started envelope names it
  under `value.engine`.
- Every session artifact path (ready.json, logs, the build summary) now
  resolves from the engine's project root, the nearest package.json,
  deno.json or deno.jsonc at or above the manifest, so a project whose
  manifest sits in a subfolder no longer makes `extension_wait` watch a
  contract the engine never writes.
- A failed `extension_build` carries the compiler errors the engine stamped
  on its contract under `value.errors`, or the bundler's own output under
  `value.output`, and its hint no longer asserts a manifest location the
  engine does not require.
- `extension_wait` on an `extension_start` session answers `launched` at
  once with the production-build guidance instead of spending its budget on
  a "transient" `E_NOT_ATTACHED` that is permanent there; a clamped budget
  is reported in `warnings` on every exit; and a dead-contract note names
  only the browser the call asked about.
- `extension_eval` names the extension's own content security policy when
  the engine refuses with "call to eval() blocked by CSP", instead of
  blaming the expression, and on MV2 Gecko a page or content
  eval goes through `tabs.executeScript` from the background when the
  engine has no scripting API, with the content-world caveat stated.
- `extension_open` with a `url` opens a new tab unless `tab` names one, so
  a page under test is never taken over; a path with no scheme resolves
  against the extension's own origin on Chromium and Gecko.
- `extension_manifest_validate` reads `public/` when resolving manifest
  references, warns rather than blocks on a missing web-accessible resource
  and on a Chromium-only side panel, counts `devtools_page` and options
  pages when ranking similar templates and ranks by surface overlap ratio,
  and on Firefox warns on a missing `browser_specific_settings.gecko.id`,
  on Chromium-only keys and on `extension_ids`, and gives an MV2 manifest
  the keys to port for MV3.
- `extension_start` takes `outputPath`, an existing unpacked extension
  directory to launch as it is through the engine's preview verb, so an
  artifact another toolchain produced, or the exact release candidate, can
  be run and watched without an Extension.js build. A directory
  with no manifest.json is refused before anything launches.
- `extension_manifest_validate` warns on Firefox when
  `browser_specific_settings.gecko.data_collection_permissions` is missing,
  which AMO now requires for new add-ons, and shows the minimal form.

Seven more from the same session's functional sweep:

- `extension_eval` reaches the Chromium background over CDP: the MV3 service
  worker or MV2 background page is a target of its own, and evaluating on it
  is the inspector path the extension's content security policy does not
  govern, so state only the worker knows is readable again under
  `script-src 'self'`. An idle worker with no target answers `E_NO_TARGET`
  with how to wake it.
- `extension_eval` with context `page` and a url evaluates on the matching
  tab's CDP target, so a site that enforces Trusted Types (YouTube, Gmail)
  no longer refuses the string; the active-tab refusal names Trusted Types
  and the url route. Every CDP route falls back to the in-bundle
  relay when the session has no debug port.
- `extension_open` asks the browser whether it is headless (HeadlessChrome
  names itself) and renders popup, options and sidebar as a tab at once
  when it is, instead of opening a popup that is gone before the next call. A page the browser swapped for its own error page answers
  `navigate-blocked` with the browser's title instead of `navigated`, and
  eval refuses such a tab.
- `extension_browsers` reports the newest managed version when several sit
  in the cache, the one the engine launches.
- `extension_inspect` probes on Gecko return the same shape as on Chromium,
  `{selector, count, samples[]}` with a text snippet per element.
- `extension_assert` on Gecko reads `background-worker-booted` off the
  control channel (the bridge executor runs in the background) and
  `surface-rendered` off the surface relay, instead of answering
  inconclusive for want of a CDP target list; a selector clause stays
  inconclusive there and names the tool that probes it.

- `@extension.dev/urls` moves to `^0.8.1`, which reserves `chromium`,
  `firefox`, `mcp` and `skill` as mint slugs.
- `extension_browsers` install hands the canary's installer the server's
  own managed-binary search as `locateInstalledBinary`, which that
  installer now requires to verify an install before it reports success.
- The stored login reader no longer types a missing entry as `undefined`
  where it promises `null`, so consumers that compile the server's source
  under `noUncheckedIndexedAccess` typecheck it.

## 10.10.1

Five Gecko findings from one agent session on Firefox and Waterfox, each replayed against a live Firefox
Nightly before and after the fix where the shape allowed it, plus four more
that followed them the same week, and the engine release that carries the
root-cause fix for the first of them.

- `extension-create`, `extension-develop` and `extension-install` move from
  4.1.29 to 4.1.30. That engine settles a promise before a surface relay
  replies to an eval (the root cause behind the first entry below, filed
  from this repo as extension.js 512), names a missing tab, a refused url,
  a closed surface and a browser exit on every act verb instead of a
  generic refusal, and lets `reload` resolve a surface's tab. The relay
  wrapper below stays: a project that pins an older engine in its own
  node_modules still drives that engine.

- `extension_eval` on a surface that answers through the in-bundle relay
  (every Gecko session, and Chromium MV2) never hands the relay a promise.
  The relay evaluates synchronously and passes the raw value to
  `sendResponse`; a promise is not cloneable, Firefox reports that to the
  sender as no reply, and the bridge then called the surface "not open"
  while the page was still running the expression. The wrapper now settles
  a thenable inside the page under a token, and the tool polls until it is
  done: an async expression returns its value, a rejection answers `E_EVAL`
  with the page's own message, and one that never settles answers
  `E_WAIT_TIMEOUT` naming where the result will land. The engine's "open it
  first: extension open newtab" hint is now spoken as the tool call it means.
- `extension_inspect` on Gecko reads a page inside the extension through
  its surface relay: a url that matches a declared surface document (the
  full `moz-extension://` address, the document path, or its file name)
  routes to that context instead of the tab injection, which Firefox
  refuses into extension pages with "Missing host permission for the tab".
  An extension url that matches no declared surface says so and names the
  ones the manifest declares.
- `extension_stop` reaps the browser the launcher recorded in `ready.json`
  (`browserPid`, `launcherPid`, and any process holding `profilePath`), so
  a Firefox started on a custom profile, or one whose argv never names the
  project, no longer survives a `stopped` answer with `reaped: []`.
- `extension_doctor` no longer calls a Gecko session unhealthy over a
  browser exit that the executor outlived: Firefox hands a fresh profile to
  a relaunched process and the first one exits 0, which the engine's browser
  leg reports as a failure while storage probes and evals keep answering.
  That leg becomes a warning that says so, and any other failure still
  counts.
- `extension_browsers` detect finds a managed binary as deep as the cache
  writes it (a Firefox Nightly sits six levels down inside its app bundle),
  so it no longer reports the system Firefox as available while
  `extension_dev` launches the cached Nightly. When both exist, the entry
  carries `systemBinaryPath` and a `devLaunches` line saying which one dev
  starts and how to choose the other. `extension_wait` reports `browserPid`
  and `profilePath` from the contract.
- `extension_open` with surface `sidebar` on Gecko no longer stops at the
  engine's "sidePanel not available", a Chromium API named on a Firefox
  engine. It asks the sidebar relay whether the `sidebar_action` panel is
  open and reports `status: "already-open"` when it is (Firefox opens the
  panel at install, so it usually is); when it is not, the document is
  rendered as a tab with the gesture rule stated (Firefox opens the panel
  only from the toolbar button or View > Sidebar, Bugzilla 1392624).
- `extension_eval` with context `page` and a `moz-extension://` url on
  Gecko evaluates through the surface relay of the document that url names,
  with a warning naming the context to pass next time, instead of "chrome.
  scripting is not available ... use context background". An extension url
  that matches no declared surface says which surfaces the manifest
  declares. The url-to-surface mapping now lives in one place for inspect
  and eval.
- `extension_dev` with `port: 0` no longer warns "Requested port 0 was not
  available": 0 asks the engine for any free port, so the note now says
  which port it picked, and the collision wording stays for a numbered port
  the server could not bind.

## 10.10.0

Safari was the one engine this server treated as a dead end, while the
Extension.js it shells out to had grown a working Safari dev loop. The client
now rides that loop, and its pinned CLI packages move to the release that
has it.

- `extension-create`, `extension-develop` and `extension-install` move from
  4.1.2 to 4.1.29, the stable release that carries the `navigate` verb
  (first shipped in a 4.1.28 canary). On Safari that engine reloads the extension
  on every save through the extension's own bridge, streams background and
  content lines into the session's log file, and points a tab at a url
  without eval; a project with no local Extension.js now gets all of that
  from the pin.
- The bridge tools work on a Safari dev session started with
  `allowControl` or `allowEval`: `extension_storage`, `extension_reload`,
  `extension_open` for surfaces, `extension_dom_snapshot` by tab id,
  `extension_logs`, and the assertions `content-script-injected`,
  `background-worker-booted`, `storage-key-present` and
  `console-errors-empty`, measured live on Safari 27. `extension_eval` in
  `content` or `page` needs a tab already open at the url, and Safari's MV3
  background CSP blocks eval in `background` and the bridge's `url`
  navigation, which the engine reports by name. `surface-rendered` and
  `extension_inspect` still need a target list Safari does not expose, and
  say so.
- `extension_browsers` reports Safari's version and an `automation` block
  (the safaridriver beside it and whether it speaks `--mcp` and `--bidi`),
  and `extension_doctor` with no `projectPath` gains a `safari-agent` leg,
  so an agent learns when Apple's Safari MCP server can pair with this one.
  The packaged CLAUDE.md and `/extension-debug` describe that pairing.
- `extension_open` with `url` asks the engine's `navigate` verb first, a
  static tabs call inside the extension that works where an MV3 background
  refuses eval, which is every Safari session. Only an engine that does not
  know the verb yet falls back to the background eval, and that fallback
  names the upgrade when Safari's CSP refuses it.
- If a dev session records a safaridriver session in `ready.json`
  (`webdriverPort`, `webdriverSessionId`), `extension_eval` with context
  `page` and `extension_open` with `url` use it for the page's main world,
  and `extension_doctor` adds a `safari-window` leg; with no such record
  the leg is a skip and both tools take the bridge.

Four defects agents met while driving the server on real extension work close in the same release.

- The initialize result now carries `instructions`: four lines that name
  the moments (run, wait, inspect, drive, build an extension) and the tools
  that own them, for clients that hide tool descriptions behind a search
  step and would otherwise show the model only a server name and a tool
  count. `createServer()` is exported so a client can initialize against
  the same server object the stdio path connects.
- `extension_open` with surface `newtab`, `history` or `bookmarks` resolves
  the `chrome_url_overrides` page itself and opens it by url. The engine's
  `open` verb never knew those surfaces and answered `E_ARGS` "unknown
  surface" to exactly what the tool description promised; an override page
  is only ever a tab, so this is the surface, not a fallback, and the hint
  says so.
- `extension_open` with surface `sidebar` on Chromium, when Chrome refuses
  `sidePanel.open()` for lack of a user gesture, opens the extension's own
  sidebar page in a tab, dispatches a synthetic click on it over CDP, calls
  `chrome.sidePanel.open` from inside that click and closes the tab. The
  panel that opens is the real one; the result reports `gesture:
"synthetic-click"` and a warning that the toolbar wiring was not
  exercised. If the click does not open it either, the sidebar document is
  rendered as a tab with the reason in a warning, and if even that fails
  the refusal gains a hint naming the url to read instead of ending the
  road. Headless sessions keep their tab fallback and never click.
- `extension_eval` on a Chromium MV3 session evaluates extension pages over
  CDP: contexts `popup`, `options`, `sidebar`, `newtab`, `history` and
  `bookmarks`, and context `page` with a `chrome-extension://` url. The
  inspector path is not governed by the extension page CSP that blocks the
  in-bundle relay's string eval, and script injection could never reach an
  extension page at all, which is where the misleading "Extension manifest
  must request permission to access this host" came from. A page that is
  not open answers `E_NO_TARGET` with the `extension_open` call that opens
  it; a thrown expression answers `E_EVAL` with the exception text; a bare
  top-level `await` parses, as in the DevTools console; MV2 Chromium and
  Gecko sessions keep the relay. Both this path and the sidebar gesture were
  measured live on Chrome for Testing 151 before release.

## 10.9.0

The client ran its browser work through CLI packages pinned three minor
releases back, so an agent driving the MCP got 4.0.30's behavior while the
same person running `extension` on their own machine got 4.1.2's. Every fix
shipped in between reached the terminal and stopped at the MCP.

- `extension-create`, `extension-develop` and `extension-install` move from
  4.0.30 to 4.1.2. The browser, logging and install paths the MCP tools call
  into now behave the way the documented CLI does.
- No tool surface changes: the same tools take the same inputs and answer the
  same shapes.

## 10.8.0

Some MCP actions change what a public channel serves or hand something to a
store, and none of those can be taken back in place. The client now carries
an approval gate for exactly those actions, so a human can stand between an
agent's proposal and the write when the platform asks for one.

- `extension_submit`, `extension_release_promote` and the destructive
  `extension_shares` actions accept an `approvalId`. When the platform's
  approval gate is on, the first call answers `approval-required` with an
  approval id and a URL a human approves at extension.dev; the same call
  repeated with that id performs the action. Rejections and pending
  approvals answer as themselves, never as a bare error.
- Approvals are bound to an action fingerprint, so an approval for one
  promote cannot be replayed on another.
- The gate is off unless the platform enables it; every existing flow is
  unchanged by default.

## 10.7.0

The published client had no idea the platform could be held, so on the five
lanes that run on our machines a reader met either a bare status code or an
honest refusal that then sent them to a page answering 503. That is what
makes someone conclude the product is broken.

- A held lane now answers one shape on `extension_publish`,
  `extension_release_promote`, `extension_submit`,
  `extension_project_create`, `extension_shares`, `extension_preview_web`
  and the registry reads behind `extension_release_status`: status
  `platform-held`, `error.platformCode` set to `PLATFORM_NOT_OPEN`, and a
  message carrying the condition, what still works, and a way back.
- What still works is the part that was missing. Creating, developing and
  packaging an extension run on your own machine, they are free forever, and
  the hold does not touch them, so `extension_create`, `extension_dev`,
  `extension_build`, `extension_manifest_validate` and `extension_doctor`
  are named in the refusal and repeated in `value.stillWorks`.
- A held refusal may not point at a held surface, so the only link it
  carries is `templates.extension.dev`, the one surface that stays open,
  and no refusal names a date.
- Registry reads no longer collapse a non-ok response to
  `<url> returned <status>`. The body is read once and its message travels
  with the result, so a refusal the platform wrote reaches the reader
  instead of a number. A held read is answered without buying an access
  grant first, because a shut lane is not an auth problem.
- The hold is recognised by the `code` field and the `x-extensiondev-hold`
  header rather than by matching the sentence, so the wording can change on
  the server without a client release.

## 10.6.1

Two reply strings pointed a stranger at surfaces the public hold keeps
dark, so the remedy they named was a dead end wearing an instruction.

- The closed-lane refusal in `extension_project_create` now relays the
  server's own message verbatim whenever the server sends one, so the
  platform decides what a caller reads there. The hardcoded console
  pointer survives only as the fallback for a refusal that carries no
  message field.
- `extension_release_status` no longer promises that publicUrl links
  need no login today. They are the public build pages and open without
  login once the project is publicly reachable, and the console Builds
  page is described as the authoritative record rather than a view the
  caller is promised to see render.

## 10.6.0

The server covered every stage of the lifecycle except the one an agent
needs most. It could read anything, so every expectation had to be
hand-rolled as a string of JavaScript over a blob, which is the guessing
the paired skill exists to prevent.

- `extension_assert` is the test stage: a list of expectations in, one
  verdict each out. Five checks ship, `background-worker-booted`,
  `surface-rendered`, `content-script-injected`, `storage-key-present`
  and `console-errors-empty`, and the run is a pass only when every one
  of them passed.
- A check that the platform cannot cover comes back `inconclusive`, never
  a pass and never a red against the extension, and carries a `settledBy`
  naming the evidence that would answer it. A content script's execution
  is not observable from outside its isolated world, so a declared
  `content_scripts` match is inconclusive rather than a pass; an absent
  MV3 worker target is inconclusive because Chrome delists an idle one;
  zero errors over a session that never wrote a log line is inconclusive
  because zero errors and zero events are the same number; a read the
  platform refuses, such as `chrome.storage` without `allowControl`, is
  inconclusive because nothing was learned about the extension.
- The verdict document is a port of the preview lane's own contract, with
  its own contract name and check registry so the two can never be
  confused, and each check names the preview check it is the
  live-browser counterpart of. A contract test pins the outcome
  vocabulary, the check and document shapes, and the aggregation rule
  against that package's own code whenever a monorepo checkout is
  reachable, the way the STORE.md corpus pins its parser.
- The manifest candidate list, which `extension_open` held three copies
  of, moves to one reader that every caller shares.

## 10.5.0

`extension_submit`'s STORE.md advisory and the platform parser that feeds
AMO and Partner Center disagreed, and the disagreement ran in the
dangerous direction: the advisory stayed silent about notes the
submission would never carry.

- The hand-rolled section and field probing in `extension_submit` is
  replaced by `src/lib/store-md.ts`, an exact port of the parser the
  submission runs. Headings the platform ignores, such as
  `### AMO reviewer notes` or a Firefox-naming Edge section, now raise
  the warning they always should have.
- A contract corpus of 14 STORE.md fixtures and a pin generated from the
  platform parser hold the two implementations together: the pin carries
  the upstream file's sha256 and its answer for every fixture, and the
  suite replays both parsers over the corpus whenever the upstream
  checkout is reachable. Neither side can move alone.
- When the notes are found, the advisory now names the file it read and
  says the submission reads STORE.md from the source repository at the
  built commit, so an uncommitted edit is never mistaken for a
  submission that carries it.

## 10.4.3

Four truths an agent reads got sharper. A share recorded twice is one
share, a feature map that points at source without the feature is a lie,
and a stale corpus snapshot makes both worse.

- `extension_shares` dedupes `localOnly` by artifactId and counts distinct
  shares in its hint; the append-only record file is untouched and
  `localRecord` reports entries beside shares so both readings stay
  available.
- `add_feature` stops pointing options and devtools at a template that
  carries neither surface, returning the full plan with an honest note
  instead of a wrong reference; the vue, svelte and preact sidebar rows
  point at their real in-framework files. A guard test now validates
  every mapping against the bundled snapshot.
- The offline template snapshot moves from the July 16 corpus to the
  current nightly: 52 templates, the renamed sidebar-monorepo-turborepo,
  sane surface data.
- `@extension.dev/urls` moves from 0.3.0 to the published 0.6.0, ending
  the last published-versus-checkout divergence the provenance guard
  tracked.

## 10.4.2

The engine moved twice in a day and the agent lane has to move with it.
`extension-develop` 4.0.30 carries the MAIN-world public path fix: a
content script running in the page's own world now resolves extension
assets through the isolated-world bridge base instead of falling back to
the host page, where it 404'd.

- `extension-create`, `extension-develop` and `extension-install` move
  from 4.0.29 to 4.0.30. The nightly `engine-pin` job added in 10.4.1 is
  what would have caught this drift; the bump is the first it prompted.

## 10.4.1

The engine this server spawns had drifted nine releases behind the one a
human gets from `npx extension@latest`. Agents were building on 4.0.20
while the published CLI was 4.0.29, so every engine fix in that range was
missing from the agent lane, including both theme-color conversions
shipped this week: a `theme.colors` project a human built green still
failed when an agent built it. Nothing in this repository changed when
the engine shipped, which is why it went unnoticed until a walk of the
MCP journey read `extension_doctor` closely.

- `extension-create`, `extension-develop` and `extension-install` move
  from 4.0.20 to 4.0.29, so the agent lane spawns the engine npm serves.
- A nightly `engine-pin` job now reads npm rather than the working tree
  and fails when a pin trails the published engine, when a pin is a range
  or a dist tag, or when it is missing. It sits beside the existing
  registry-listing watch, because the event that invalidates both happens
  in another repository.

## 10.4.0

Every place a tool named a template, it pointed the caller at GitHub and
never at the catalog that serves the same template with screenshots,
metadata and a deploy button. The MCP was routing around its own front
door. Template emissions now carry the catalog detail URL alongside the
existing fields, and the offline fallback corpus moved to the commit the
catalog actually serves.

- `extension_templates` list results gain `catalogUrl`,
  `https://templates.extension.dev/<slug>?utm_source=mcp&utm_medium=tool`,
  beside `repositoryUrl` and `downloads`, which are unchanged. The source
  view and `extension_add_feature`'s reference template carry the same
  field.
- `extension_create` results gain `templateCatalogUrl` for the template
  the project was scaffolded from, with `utm_source=mcp-create` so
  create-path visits stay distinguishable from browse-path visits.
- The pinned fallback template corpus moved to `52c0d871c433`, the commit
  the live `latest` channel pointer resolves to, so the offline corpus and
  the catalog agree.

## 10.3.1

The 10.3.0 tarball shipped two comments a stranger could read: an HTML
comment in the popup markup naming a private package, and an eight line
internal roadmap comment plus two inline script comments in the live
preview sandbox page. Both were removed at source right after that
release. This release exists to take them off the registry, because a
published tarball cannot be edited in place.

- The popup markup no longer names any private package.
- `extensions/live-preview/chromium/sandbox/page-0.html` ships exactly
  the markup it runs, with no comments at all.

## 10.3.0

Four fixes for places where a tool answered confidently about something it
had not actually checked: a login refusal that never said where the slugs
come from, a doctor report labelled with a browser that had no session, a
preview probe that certified whatever was listening on the port, and a
release gate that passed on a stale bundle.

- `extension_auth login` refused a malformed `project` without saying
  where the two slugs come from. Both the refusal and the input schema now
  name the console address bar as the source: an existing project's page is
  `console.extension.dev/<workspace>/<project>`, and a project that does
  not exist yet is created at extension.dev/new first.
- `extension_doctor` diagnoses the session that exists, not a hardcoded
  default. The shared session resolver only counts contracts marked
  "ready", which is exactly wrong for the tool you reach for when a session
  failed: doctor fell back to chrome, labelled the report with it, read the
  absent contract, and returned a healthy verdict over a session that had
  errored. When there is no ready session, the browser with a contract on
  disk wins, newest first and whatever its status.
- `extension_preview_web` certifies the probe against the build the call
  just minted instead of against the port. Anything can be listening on the
  local preview port, and the old probe read `hostReachable` and
  `previewLoadable` as true off whatever JSON came back, then echoed that
  server's `identifier`, name and version into the envelope unmarked, which
  made any local server a text channel into the agent's context. The name
  and version must now match the `dist` manifest read off disk, and the
  identifier is echoed only when it matches the derivation the real
  middleware uses. A mismatch returns the status
  `host-serving-different-artifact` with `previewLoadable: false`, and
  anything the host claimed that could not be confirmed locally travels
  clipped under `probe.hostReported`, named as the host's claim.
- The release gate asserts the version the built bundle exports rather than
  grepping the bundle for the version string. The grep greenwashed: the
  bundle carries the pinned engine version and fifty-two `"version":"1.0.0"`
  strings from the template corpus, so a release cut at any of those
  numbers passed the gate over a stale `dist`. `dist/module.js` now exports
  the manifest version it inlined at build time, and the gate reads it back
  and compares.

## 10.2.0

A production walk of the full share-and-publish loop, then a fix for every
roughness it surfaced, on top of a week of engine tracking and preview
hardening. Everything landed since 10.1.0 ships here; the 10.1.1 version
bump was never published and is folded in.

- Revoking a share accepts the ids the platform actually mints: `gen_` plus
  64 hex characters, with the older 32-character form still valid. A
  malformed reference is refused by name, with what a real id looks like,
  instead of being silently cut down to a 32-character prefix that revokes
  nothing while reporting the wrong cause.
- Every revoke handle the tools return points at `www.extension.dev`
  directly, so one plain DELETE works. The apex `extension.dev` answers
  DELETE with a redirect, and a caller that does not follow redirects got
  "Redirecting..." back while the share stayed live.
- `extension_doctor` hands over the CLI's own report when the engine exits
  nonzero with output the server cannot parse: the response carries
  `cliReport`, the doctor's actual check list and remediations, instead of
  discarding it and guessing that the local CLI is stale.
- `extension_inspect` with no `url` ranks the extension's own surfaces
  first and the toolchain's pages last, so it no longer inspects the
  Extension.js welcome surface and reports on the wrong document. When only
  toolchain or override pages are open, a warning names exactly which page
  was inspected and how to target yours.
- `extension_publish` against a host where the token's project does not
  exist now says what to do: check the token's scope with `extension_auth`,
  create the project first at extension.dev/new, or log in against a
  project that exists there.
- `extension_auth status` asks the platform who the stored credential
  really is instead of trusting the file on this machine, and reports the
  three answers apart: the server confirmed it, the server refused it and
  the workspace shown is only a local claim, or the server could not be
  reached and nothing here is server confirmed. A credential minted against
  a development deployment reads as refused where production refuses it,
  which is what it always was and never said.
- The MCP `isError` flag now agrees with the envelope: every `ok: false`
  result is marked `isError: true`, so an agent branching on the transport
  flag no longer reads a platform refusal, a publish 404 or an auth 401, as
  success.
- `extension_preview_web` with `share: true` no longer fails a working
  share because the local dev lane is dead: the uploaded link is what was
  asked for, so the result is `ok: true` with status `shared` and a warning
  naming the unreachable local leg, which is expected outside the
  extension.dev monorepo.
- The Extension.js engine pin moved to 4.0.20, the server asks the engine
  its version and JSON support from its published capabilities instead of
  paying for a second build to find out, and a canary pin no longer parses
  to NaN.
- Safari packaging lets an agent name the app and bundle id it is
  packaging, and the docs say what a derived bundle id actually costs a
  developer instead of claiming Apple rejects it.
- Preview and share housekeeping: `hostUrl` is pinned to a local server,
  stale carriers are cleared on start and swept on every exit, re-sharing
  is documented for what it really does, and the CORS verdict is read off
  the last hop a browser would follow.
- The offline template fallback points at the published corpus, three
  control refusals are told apart instead of sharing one message, and a
  stray binary file no longer ships in the package.

## 10.1.0

A six-lens audit of the whole surface (auth, platform, run, see, act and
build, plumbing) followed by a fix pass over everything it confirmed. 33
fixes, the ones you would notice first:

- A failed spawn of the dev CLI (npx missing from PATH) no longer crashes
  the whole MCP server; it fails that one call with guidance.
- `extension_wait` now ignores ready contracts stamped before the current
  session, so a leftover file from a crashed run can no longer report the
  previous session's compile error as yours.
- `extension_create` never deletes a directory it did not create: the
  transient-failure cleanup used to wipe pre-existing directories, including
  their `.git`, when scaffolding into one.
- `extension_submit` dry runs are platform-primary: a platform-reported
  preflight failure can no longer be overwritten by locally computed store
  health, and token-only CI callers no longer fail the dry run for lacking a
  local credentials file. The tool also gained a `projectPath` input so the
  STORE.md advisory check reads the project, not the server's cwd.
- `manifest.json` with `world: "MAIN"` no longer fails Firefox validation:
  Firefox has supported the MAIN world since 128. The rule is now a
  strict_min_version advisory.
- Device login reports hard server errors as errors, on both the tool and
  the CLI paths, instead of authorization-pending or a bogus timeout; the
  login flow now enforces the same cleartext-http refusal as every other
  token-bearing path, validates the returned project scope before storing
  credentials, and the CLI prints the one-click approval link.
- `extension_publish` with a pinned buildSha no longer fills the response
  with a different build's metadata when the pin is not in the local index.
- `extension_shares` no longer labels your own expired shares as "not owned
  by this token" when listing with `status: "live"`, and revocation is only
  reported permanent when the platform confirmed it.
- `extension_logs` accepts the `newtab`, `history`, and `bookmarks`
  contexts, `level: "off"` silences console output instead of returning all
  of it, and a stream error mid-follow returns what was collected instead
  of discarding it.
- `extension_stop` and session bookkeeping survive an MCP restart: session
  markers are cleaned when a session exits on its own, single-project stop
  consults the same on-disk markers as `all: true`, orphan reaping escapes
  regex metachars in project paths and only kills plausible session
  processes, and a replaced session can no longer unregister its successor.
- `extension_open` trusts the live browser over the computed id hash when
  they disagree (symlinked dist paths), so it no longer navigates to a
  nonexistent extension id and no longer reports a successfully opened
  surface as a failure.
- Offline first runs work: the bundled template catalog snapshot is now the
  fallback when the network and cache are both unavailable, a corrupted
  cache file heals instead of erroring, and a shapeless 200 response is no
  longer cached for an hour.
- `extension-mcp --help`, `--version`, and unknown commands now answer
  instead of silently starting a stdio server.
- The release pipeline bumps the version before building, so the published
  bundle reports the version it ships as, with an assertion gating publish
  on it and on the type declarations existing.
- Docs and drop-ins caught up with the code: template count corrected to
  50+, the AI template slugs are `ai-claude` and `ai-chatgpt`, Firefox
  support noted for `extension_list_extensions` and Safari for
  `extension_submit`, and the `extension_dom_snapshot` description names
  which subpaths need the debug port.

## 10.0.0

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
wins over this package's pin, so the version is not knowable in advance. The
contract's own error stamps are read whatever the engine's age, so a locked
profile is named as one the moment the engine records it.

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

| Old tool                                                                  | New call                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `extension_detect_browsers({ browsers })`                                 | `extension_browsers({ action: "detect", browsers })`                                  |
| `extension_list_browsers()`                                               | `extension_browsers({ action: "list" })`                                              |
| `extension_install_browser({ browser })`                                  | `extension_browsers({ action: "install", browser })`                                  |
| `extension_uninstall_browser({ browser, all })`                           | `extension_browsers({ action: "uninstall", browser, all })`                           |
| `extension_login({ project, deviceCode, api })`                           | `extension_auth({ action: "login", project, deviceCode, api })`                       |
| `extension_whoami()`                                                      | `extension_auth({ action: "status" })`                                                |
| `extension_logout()`                                                      | `extension_auth({ action: "logout" })`                                                |
| `extension_list_templates({ surface, framework, tags, featured, query })` | `extension_templates({ action: "list", surface, framework, tags, featured, query })`  |
| `extension_get_template_source({ slug, files })`                          | `extension_templates({ action: "source", slug, files })`                              |
| `extension_release_list({ workspace, project, api })`                     | `extension_release_status({ include: ["releases"], workspace, project, api })`        |
| `extension_store_status({ workspace, project, api })`                     | `extension_release_status({ include: ["stores"], workspace, project, api })`          |
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

| 7.0.0 call                                                                | 9.0.0 call                                                                            | Landed in |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------- |
| `extension_deploy(...)`                                                   | `extension_submit(...)`                                                               | 8.0.0     |
| `extension_inspect({ projectPath })`                                      | `extension_analyze({ projectPath })`                                                  | 8.0.0     |
| `extension_source_inspect(...)`                                           | `extension_inspect(...)`                                                              | 8.0.0     |
| `extension_dom_inspect(...)`                                              | `extension_dom_snapshot(...)`                                                         | 8.0.0     |
| `extension_detect_browsers({ browsers })`                                 | `extension_browsers({ action: "detect", browsers })`                                  | 9.0.0     |
| `extension_list_browsers()`                                               | `extension_browsers({ action: "list" })`                                              | 9.0.0     |
| `extension_install_browser({ browser })`                                  | `extension_browsers({ action: "install", browser })`                                  | 9.0.0     |
| `extension_uninstall_browser({ browser, all })`                           | `extension_browsers({ action: "uninstall", browser, all })`                           | 9.0.0     |
| `extension_login({ project, deviceCode, api })`                           | `extension_auth({ action: "login", project, deviceCode, api })`                       | 9.0.0     |
| `extension_whoami()`                                                      | `extension_auth({ action: "status" })`                                                | 9.0.0     |
| `extension_logout()`                                                      | `extension_auth({ action: "logout" })`                                                | 9.0.0     |
| `extension_list_templates({ surface, framework, tags, featured, query })` | `extension_templates({ action: "list", surface, framework, tags, featured, query })`  | 9.0.0     |
| `extension_get_template_source({ slug, files })`                          | `extension_templates({ action: "source", slug, files })`                              | 9.0.0     |
| `extension_release_list({ workspace, project, api })`                     | `extension_release_status({ include: ["releases"], workspace, project, api })`        | 9.0.0     |
| `extension_store_status({ workspace, project, api })`                     | `extension_release_status({ include: ["stores"], workspace, project, api })`          | 9.0.0     |
| `extension_preview({ projectPath, browser, port, noBrowser, ...launch })` | `extension_start({ projectPath, build: false, browser, port, noBrowser, ...launch })` | 9.0.0     |

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

| Old name                   | New name                 |
| -------------------------- | ------------------------ |
| `extension_deploy`         | `extension_submit`       |
| `extension_inspect`        | `extension_analyze`      |
| `extension_source_inspect` | `extension_inspect`      |
| `extension_dom_inspect`    | `extension_dom_snapshot` |

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
  on. Entries list INSTALLED add-ons regardless of
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
  truncate. The workaround stays until the engine flushes before exiting.

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
