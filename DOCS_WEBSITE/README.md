# DOCS_WEBSITE

Source `.mdx` for the **agent-bridge / MCP / publish** documentation, relocated
here from the public docs site (`extension.js.org` `docs/ai/`). These pages cover
platform/MCP-scoped features, so they live with the MCP package rather than in
the open-source docs site.

| File | Topic |
| --- | --- |
| `agent-bridge.mdx` | The free, local agent bridge (overview) |
| `logs.mdx` | `extension logs` / `extension_logs` |
| `inspect-and-act.mdx` | `inspect` + `act` (eval/storage/reload/open) |
| `mcp.mdx` | `@extension.dev/mcp` server + tools |
| `publish.mdx` | `publish` / `extension_publish` (extension.dev) |

These are Mintlify-flavored `.mdx` (note `<Note>`, `<CodeGroup>`, `/docs/...`
links that resolve against the docs site). When this content is published to a
platform/MCP docs surface, re-point those cross-links accordingly.

Not built or served from this package — this is the source of truth for the
relocated section. See `docs/login-command-todo.md` for the related `login` work.
