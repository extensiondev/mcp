// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const CORE_RULES = [
  "no-nested-ternary",
  "require-await",
  "no-await-in-loop",
  "consistent-return",
  "no-void",
  "no-underscore-dangle",
  "no-shadow",
  "default-case",
  "no-new-func",
  "no-multi-assign",
  "no-redeclare",
  "no-new",
  "no-eval",
  "no-script-url",
  "no-empty",
  "no-template-curly-in-string",
  "no-throw-literal",
  "radix",
  "no-restricted-globals",
  "import/no-named-as-default-member",
  "import/order",
  "import/no-named-as-default",
  "import/no-duplicates",
  "import/no-cycle",
  "promise/param-names",
  "node/no-process-exit",
  "node/no-extraneous-import",
  "node/prefer-global/url",
  "node/prefer-global/process",
  "node/no-missing-require",
  "node/hashbang",
  "import/first",
]

const TS_RULES = [
  "@typescript-eslint/no-shadow",
  "@typescript-eslint/no-use-before-define",
  "@typescript-eslint/default-param-last",
  "@typescript-eslint/no-unused-vars",
  "@typescript-eslint/no-unused-expressions",
  "@typescript-eslint/no-empty-function",
]

const toWarn = (rules) => Object.fromEntries(rules.map((r) => [r, "warn"]))

export const migrationWarnings = [
  {
    name: "extensiondev/migration-warnings",
    rules: toWarn(CORE_RULES),
  },
  {
    name: "extensiondev/migration-warnings-js",
    files: ["**/*.{js,jsx,mjs,cjs}"],
    rules: toWarn(["no-unused-vars"]),
  },
  {
    name: "extensiondev/migration-warnings-ts",
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: toWarn(TS_RULES),
  },
]
