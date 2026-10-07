#!/usr/bin/env node
// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {createRequire} from 'node:module'
import {startServer, runCli, isServerFlag, resolveServerOptions} from '../dist/module.js'

const require = createRequire(import.meta.url)
const {version} = require('../package.json')

const usage = `@extension.dev/mcp ${version}

Usage:
  extension-mcp [flags]         Start the MCP server on stdio
  extension-mcp login [flags]   Device login at extension.dev
  extension-mcp logout          Remove the stored credentials
  extension-mcp whoami          Show the stored identity
  extension-mcp release [...]   Headless release commands
  extension-mcp --version       Print the version

Server flags:
  --features=local,platform     Tool groups to expose (default: local)
  --no-ship                     Refuse publish, promote, real submits,
                                share links and share revokes
  --project <workspace>/<proj>  Use only this project's login
`

const [, , cmd, ...rest] = process.argv

if (cmd === undefined || isServerFlag(cmd)) {
  const resolved = resolveServerOptions(process.argv.slice(2), process.env)
  if (!resolved.ok) {
    process.stderr.write(`${resolved.message}\n\n${usage}`)
    process.exit(1)
  }
  startServer(resolved.options)
} else if (['login', 'logout', 'whoami', 'release'].includes(cmd)) {
  runCli(cmd, rest)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err?.message || String(err)}\n`)
      process.exit(1)
    })
} else if (['--version', '-v'].includes(cmd)) {
  process.stdout.write(`${version}\n`)
} else if (['--help', '-h', 'help'].includes(cmd)) {
  process.stdout.write(usage)
} else {
  process.stderr.write(`Unknown command "${cmd}"\n\n${usage}`)
  process.exit(1)
}
