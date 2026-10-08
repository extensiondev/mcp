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

const filesOverTheLineBudgetOnOctoberSeventh2026 = [
  "src/__tests__/approval-gate.test.ts",
  "src/__tests__/assert-verdicts.test.ts",
  "src/__tests__/auth-batch-login.test.ts",
  "src/__tests__/build-safari-packaging.test.ts",
  "src/__tests__/engine-version-probe.test.ts",
  "src/__tests__/eval-chromium-background-and-web.test.ts",
  "src/__tests__/eval-gecko-protocol-route.test.ts",
  "src/__tests__/gecko-bridge-pairing.test.ts",
  "src/__tests__/open-surface-as-tab.test.ts",
  "src/__tests__/preview-web.test.ts",
  "src/__tests__/project-create-batch.test.ts",
  "src/__tests__/project-create.test.ts",
  "src/__tests__/reports-failure.test.ts",
  "src/__tests__/shares.test.ts",
  "src/__tests__/webdriver-safari.test.ts",
  "src/lib/cdp-extension-page.ts",
  "src/lib/project-create-batch.ts",
  "src/lib/rdp.ts",
  "src/lib/vendor/chrome-theme/chrome-theme-resolve.ts",
  "src/tools/assert.ts",
  "src/tools/build.ts",
  "src/tools/detect-browsers.ts",
  "src/tools/dev.ts",
  "src/tools/doctor.ts",
  "src/tools/dom-snapshot.ts",
  "src/tools/eval.ts",
  "src/tools/inspect-gecko.ts",
  "src/tools/login.ts",
  "src/tools/logs.ts",
  "src/tools/manifest-validate.ts",
  "src/tools/open.ts",
  "src/tools/preview-web.ts",
  "src/tools/project-create.ts",
  "src/tools/shares.ts",
  "src/tools/stop.ts",
  "src/tools/submit.ts",
];

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
    files: filesOverTheLineBudgetOnOctoberSeventh2026,
    rules: { "max-lines": "off" },
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
