# Security policy

## Report a vulnerability

Use [private vulnerability reporting](https://github.com/extensiondev/mcp/security/advisories/new) on this repository, not a public issue. It reaches the maintainer directly.

A useful report names:

- the version (`npx -y @extension.dev/mcp --version`), the MCP client and the operating system
- the tool and the arguments that trigger it, or the steps from a fresh install
- what an attacker gains: a file read, a command run, a credential, a call that reaches people outside the machine

## Supported versions

Fixes ship in the next release of `@extension.dev/mcp` on npm. Only the latest published version receives them, so upgrade before you report.

## Scope

This repository holds the stdio server published as `@extension.dev/mcp`. Reports about the hosted server at `mcp.extension.dev` or about extension.dev itself use the same form.

The server's own guarantees (the eval gate, the no-ship mode, what leaves the machine) are under [Security](README.md#security) in the README.
