# Install extension.dev MCP

These steps are written for an AI agent to follow with no person in the loop. They install extension.dev MCP (`@extension.dev/mcp`), the MCP server that builds, runs, debugs, tests and ships Chrome, Firefox, Edge and Safari extensions.

## Requirements

- Node.js 22.12 or newer. Check with `node --version` and stop if it is older.
- `npx`, which ships with Node.js. Nothing is installed globally.
- No account, API key or login for the local tools.

## Install

The server runs over stdio from one command:

```bash
npx -y @extension.dev/mcp@latest
```

Add it to the client's MCP settings file under `mcpServers`, with the name `extension-dev`:

```json
{
  "mcpServers": {
    "extension-dev": {
      "command": "npx",
      "args": ["-y", "@extension.dev/mcp@latest"]
    }
  }
}
```

This starts the local tools alone: create, dev, build, inspect, assert and the rest of what runs on this machine.

## Check that it started

Call `extension_doctor({})` first. A working install answers with these fields, among others:

```json
{
  "ok": true,
  "command": "extension_doctor",
  "status": "healthy",
  "value": {
    "mode": "environment",
    "checks": [
      { "check": "node", "status": "pass" },
      { "check": "extension-cli", "status": "pass" },
      { "check": "template-cache", "status": "warn" }
    ]
  }
}
```

A `warn` leg is fine: the template cache fills on the first `extension_templates` call. A `fail` leg carries a `remediation` line; follow it and call `extension_doctor({})` again. The first call can take up to a minute while `npx` downloads the Extension.js engine.

## Platform tools (optional)

Sharing a preview, releasing and submitting to the Chrome Web Store, Firefox Add-ons, Edge Add-ons and the App Store go through extension.dev and need a login. Leave them off unless the person asks for one of those.

To turn them on, add `"--features=local,platform"` to `args`, restart the server, then call:

```
extension_auth({ action: "login", project: "<workspace>/<project>" })
```

The person approves a code at https://extension.dev/device. The token stays on the machine and is never returned to the agent.

## Environment variables

All are optional.

| Variable | Effect |
| --- | --- |
| `EXTENSION_DEV_FEATURES` | `local` (default), `local,platform`, or either with `,extras` for the theme check and the network stubs; same as `--features` |
| `EXTENSION_DEV_NO_SHIP` | `1` refuses every call that puts something in front of other people |
| `EXTENSION_DEV_PROJECT` | `<workspace>/<project>`; refuses any call that names another project |
| `EXTENSION_DEV_TOKEN` | An access token in place of the device login, for CI |
| `EXTENSION_DEV_NO_AUTO_OPEN` | `1` never opens the approval page in the default browser |
| `EXTENSION_DEV_NO_TELEMETRY` | `1` sends no telemetry; `DO_NOT_TRACK=1` does the same |

## Troubleshooting

- The client lists no `extension_` tools: confirm `node --version` is 22.12 or newer, then restart the client.
- `E_AUTH_REQUIRED` or `E_AUTH_EXPIRED` on a platform tool: run the `extension_auth` login above and call again.
- Anything else: `extension_doctor({})` names the broken leg and how to fix it.

Full reference: https://docs.extension.dev/tools/mcp
