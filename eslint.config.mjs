// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import auditorRecommended from "eslint-config-auditor/recommended";
import auditorTypescript from "eslint-config-auditor/typescript";
import globals from "globals";

import { migrationWarnings } from "./eslint/migration-warnings.mjs";
import { styleRules } from "./eslint/style-rules.mjs";

/* @invariant
  * THIS IS THE CONSOLE'S LINT, MINUS WHAT A NODE PACKAGE CANNOT USE.
  * apps/web/console.extension.dev in the monorepo lints through
  * @extensiondev/config/eslint/react-internal: eslint-config-auditor's
  * recommended and typescript presets, consistent type imports, the 400-line
  * warning, the migration warnings, the house style plugin (padding lines,
  * curly, banner-aware header and divider rules, no JSDoc prose) and the
  * house-rule bypass. This repository is published on its own and cannot
  * depend on that private package, so eslint/ carries a copy of the two house
  * modules and this file mirrors base.js plus react-internal.js by hand. Left
  * out on purpose: the React and jsx-a11y layers, the browser globals, the
  * Tailwind rhythm rules and the icon or image import bans, none of which has
  * a target in a stdio server. Keep this in step with the monorepo copy.
  */
const houseRuleBypass = {
  rules: {
    "no-await-in-loop": "off",
    "no-nested-ternary": "off",
    "require-await": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "no-void": "off",
    "consistent-return": "off",
    "max-params": "off",
    "no-underscore-dangle": "off",
    "import/no-named-as-default-member": "off",
    "node/no-process-exit": "off",
  },
};

export default [
  {
    ignores: [
      "dist/",
      "coverage/",
      "node_modules/",
      "extensions/live-preview/**",
      "**/.turbo/**",
    ],
  },
  ...auditorRecommended,
  ...auditorTypescript,
  { languageOptions: { globals: globals.node } },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
    },
  },
  {
    files: ["src/**/*.{js,ts}"],
    rules: {
      "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
  ...migrationWarnings,
  ...styleRules,
  houseRuleBypass,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.{test,spec}.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
