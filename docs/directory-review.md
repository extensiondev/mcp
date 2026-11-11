# Directory review: the hosted server

The hosted server at `https://mcp.extension.dev/mcp` serves six tools of this package through
`src/hosted.ts`. This page is the audit of those six against the Claude connector review
(https://claude.com/docs/connectors/building/review-criteria, read 2026-11-11) and the OpenAI
plugin review (https://developers.openai.com/apps-sdk/app-submission-guidelines, read 2026-11-11).
It is kept current by `src/__tests__/hosted-tools.test.ts`, which pins the title and the four
hints of every hosted tool.

## The tools

| Tool | Name length | title | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Mixes read and write across actions | Answer text naming a plan, price or upgrade |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `extension_auth` | 14 | Read the signed-in identity | true | false | true | true | No: hosted serves `status` alone | None |
| `extension_workspace` | 19 | Read the workspace | true | false | true | true | No: hosted serves `info`, `projects`, `settings`, all reads | None of its own since this audit; `value.plan` relays the platform's allowance record as the console shows it |
| `extension_project_create` | 24 | Create a project | false | false | false | true | No: one operation | None of its own; a refused create relays the platform's sentence |
| `extension_builds` | 16 | Read and rebuild builds | false | true | false | true | Yes: `list`, `get`, `logs` read; `rebuild`, `recheck`, `configure`, `create-channel`, `configure-channel`, `delete-channel` write | None of its own; a refused rebuild relays the platform's sentence and its `upgradeUrl` |
| `extension_release_status` | 24 | Read the release status | true | false | true | true | No: one read with `include` | None |
| `extension_release_promote` | 25 | Promote a release | false | true | false | true | No: `promote`, `cut`, `rollback` all write | None of its own; a refused release relays the platform's sentence and its `upgradeUrl` |

Every tool lists its title twice, as the tool's `title` (MCP 2025-06-18) and as
`annotations.title`, and every hint is an explicit boolean (`listedToolEntry` in
`src/lib/tool-dispatch.ts`). A hosted projection with fewer actions than its module names its own
title and hints in `src/hosted.ts`; the rest come from the table in `src/lib/tool-annotations.ts` through `src/lib/tool-policy.ts`. The `download`
action and its `to` input are not served hosted: they save a package to the caller's disk, which
a hosted server does not have.

## Transport and sign-in, read by hand on 2026-11-11

- Transport: Streamable HTTP, stateless, JSON answers (`StreamableHTTPServerTransport` with
  `enableJsonResponse: true` in the monorepo's `apps/web/mcp.extension.dev/server/http.ts`). A
  GET on the endpoint answers 405 once signed in; no SSE stream is offered.
- `POST /mcp` with no token answers 401 with
  `WWW-Authenticate: Bearer error="invalid_token", error_description="No authorization provided", resource_metadata="https://mcp.extension.dev/.well-known/oauth-protected-resource/mcp"`.
  An unauthenticated `initialize` is refused, so `tools/list` is read from the code and its
  tests, not from the live server.
- `/.well-known/oauth-protected-resource/mcp` answers `resource: "https://mcp.extension.dev/mcp"`
  and `authorization_servers: ["https://www.extension.dev"]`; the root document answers
  `resource: "https://mcp.extension.dev"`.
- `https://www.extension.dev/.well-known/oauth-authorization-server` answers a
  `registration_endpoint` (dynamic client registration, RFC 7591),
  `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`,
  `grant_types_supported: ["authorization_code", "refresh_token"]` and
  `scopes_supported: ["projects", "offline_access"]`. It does not advertise
  `client_id_metadata_document_supported`, so Claude registers through DCR on every fresh
  connection.
- `https://mcp.extension.dev/.well-known/openai-apps-challenge` answers 404: the OpenAI domain
  proof is not served yet.

## Open items

1. `extension_builds` mixes reads and writes under one `action` input. The MCP specification
   carries one `annotations` object per tool and none per action, so a `tools/list` cannot label
   `list` read-only and `rebuild` destructive on the same tool; the tool is listed non-read-only
   and destructive, which is what the Claude review's "Separate read and write tools" rule flags
   and what the OpenAI review's "expose each operation as a separate tool" rule reads the same
   way. The fix is a split at the policy table: a read-only `extension_builds` (`list`, `get`,
   `logs`) and a write tool for `rebuild`, `recheck`, `configure` and the channel actions.
2. A refused rebuild, release or create relays the platform's own sentence and, when the platform
   sends one, `value.upgradeUrl`. The platform's sentence for a spent monthly allowance names the
   paid tier and its price, by the www invariant "the price rides on the refusal, in the server's
   words" (2026-11-06). The OpenAI review refuses pricing, subscription and upgrade text inside a
   plugin. Whether the platform keeps that sentence off answers to connected-app tokens is the
   owner's decision, not this package's.
3. The OpenAI domain proof (`/.well-known/openai-apps-challenge`) is served only once the
   submission form hands out its token.
4. Reviewer accounts for both directories are hand steps for the owner; see the checklist below.

## Reviewer account checklist

One account, one workspace, one sample project in every state a reviewer would look at. Nothing
here is created by an agent.

- [ ] A workspace owned by a review-only sign-in (a password sign-in with no second factor, no
      magic link and no sign-up step, as the OpenAI review requires; the Claude review asks for
      "a fully populated account").
- [ ] One project with a connected store (Chrome Web Store is enough) so `extension_release_status`
      answers store status.
- [ ] A build that ran and passed, so `extension_builds` `list`, `get` and `logs` answer rows and
      lines.
- [ ] A release on Preview and one on Stable, so `extension_release_status` answers channels and
      history and `extension_release_promote` has a build to move.
- [ ] A refused submit on record (a store the project is not connected to, or a build with no
      artifact for it), so a negative test case has a refusal to show.
- [ ] A store submission still pending review, so the status page and the history carry a held
      release.
- [ ] Claude review: the account's sign-in, the server URL, confirmation that every tool was run
      in MCP Inspector and as a custom connector, a public documentation page
      (https://docs.extension.dev/tools/mcp), a privacy policy link, a support contact and at
      least three example prompts.
- [ ] OpenAI review: the same account without a second factor, five positive test cases (prompt,
      expected tools, expected behavior), three negative test cases, a demo video the reviewer
      can open, release notes, and the domain proof served at
      `https://mcp.extension.dev/.well-known/openai-apps-challenge`.
