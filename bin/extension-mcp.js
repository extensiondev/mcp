#!/usr/bin/env node
import {startServer, runCli} from '../dist/module.js'

const [, , cmd, ...rest] = process.argv

if (cmd && ['login', 'logout', 'whoami', 'release'].includes(cmd)) {
  runCli(cmd, rest)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err?.message || String(err)}\n`)
      process.exit(1)
    })
} else {
  // No subcommand: run as the MCP stdio server (the default and primary mode).
  startServer()
}
