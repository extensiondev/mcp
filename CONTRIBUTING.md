# Contributing

Thanks for helping. This guide covers how to run the suite, how to report a bug and how a change lands.

## Run the suite

You need Node.js 22.12 or newer and pnpm 10 (`corepack enable` picks the version `package.json` names).

```bash
pnpm install
pnpm compile
pnpm test
pnpm typecheck
pnpm lint
```

Run `pnpm compile` before `pnpm test` after any source change: one spec reads `dist/`. `pnpm lint` fails above the warning cap in `package.json`; a change adds no warnings.

Some files are generated. Edit the source and regenerate them instead of editing them by hand:

- the setup block in `README.md` comes from `src/clients` (`pnpm readme:clients`)
- `docs/tools.json`, `docs/clients.json` and `claude/reference/mcp-tools.md` come from the tool definitions (`pnpm docs:tools`)

## Report a bug

Open an issue with the [bug form](https://github.com/extensiondev/mcp/issues/new?template=bug_report.yml). The answer the tool gave is the most useful part: its `status`, `error.code` and `hint`. Name the version (`npx -y @extension.dev/mcp --version`), the MCP client, the browser and the operating system.

Security reports never go in a public issue. See [SECURITY.md](SECURITY.md).

Questions and ideas are welcome on [Discord](https://discord.gg/BRqbPDfPxb).

## Send a change

- Every fix carries a test that fails without it. Add the case to the existing spec for that module rather than opening a new spec file.
- Keep the code free of explanatory comments; each file keeps only its license banner.
- Write copy in American English, with no em dashes.
- Leave the version and the changelog alone. The maintainers cut releases from CI.

### Commit messages

One natural sentence, at most 74 characters, with no prefix such as `feat:` or `fix:` and no trailers.

```text
Report the missing permission when a content script never injects
```

## Code of conduct

Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).
