# Install extension.dev MCP

extension.dev MCP (`@extension.dev/mcp`) is the MCP server for building browser extensions: it builds, runs, debugs, tests and ships Chrome, Firefox, Edge and Safari extensions from an AI agent. These steps install it, and they are written for an AI agent to follow with no person in the loop.

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

A `warn` leg is fine: the template cache fills on the first `extension_templates` call. A `fail` leg carries a `remediation` line; follow it and call `extension_doctor({})` again. The first call can take up to a minute while `npx` downloads the engine that builds and runs the extension.

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
| `DO_NOT_TRACK` | `1` sends no telemetry, the same as `EXTENSION_DEV_NO_TELEMETRY=1` |
| `EXTENSION_DEV_API_URL` | The extension.dev platform the platform tools and docs search call; unset is `https://www.extension.dev` |
| `EXTENSION_MCP_CLI_VERSION` | The engine version to run when the project has none of its own |
| `EXTENSION_MCP_ENGINE_DIR` | Runs every engine command from a compiled engine checkout |
| `EXTENSION_MCP_ENGINE_BIN` | Runs every engine command from one engine bin file |
| `EXTENSION_HEADLESS` | `1` launches every browser headless |
| `EXTENSION_BROWSER_FLAGS` | Extra flags for every browser the engine starts |
| `EXT_BROWSERS_CACHE_DIR` | The folder that holds the managed browsers |
| `EXTENSION_MCP_SESSION_DIR` | The folder for the running sessions' state files |
| `EXTENSION_TRY_DIR` | The folder where `extension_try` unpacks a published build |
| `EXTENSION_ISOLATED_DIR` | The folder for isolated runs |
| `EXTENSION_KEEP_SOCKET_PROCESS` | `1` keeps Firefox's socket process on Linux with an engine older than 4.3.0 |

## Troubleshooting

- The client lists no `extension_` tools: confirm `node --version` is 22.12 or newer, then restart the client.
- `E_AUTH_REQUIRED` or `E_AUTH_EXPIRED` on a platform tool: run the `extension_auth` login above and call again.
- Anything else: `extension_doctor({})` names the broken leg and how to fix it.

Full reference: https://docs.extension.dev/tools/mcp
