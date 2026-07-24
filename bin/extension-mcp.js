#!/usr/bin/env node
// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

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
  startServer()
}
