// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import stylistic from "@stylistic/eslint-plugin"

const BANNER_ART = /[█╔╗╚╝║]/
const DECORATION_ONLY = /^\s*[-─━═=~*#]{3,}\s*$/
const DASH_WRAPPED_TITLE = /^\s*-{2,}\s+(.*?)\s+-{2,}\s*$/
const BOX_RULE = /[─━═]{3,}/
const BOX_EDGES = /^[\s─━═]+|[\s─━═]+$/g

const FUNCTIONAL_COMMENT =
  /^\s*(@invariant\b|@deprecated\b|eslint|global\s|globals\s|exported\s|@ts-|@type\b|@typedef\b|@template\b|@satisfies\b|@import\b|prettier-ignore|biome-ignore|design-lint-ignore|v8 ignore|c8 ignore|istanbul ignore|webpack[A-Z]|@vite-ignore|@jsx|@vitest-|@jest-environment|@flow\b|@vue|@refresh\b|[#@]__(PURE|NO_SIDE_EFFECTS|INLINE|KEY)__|<reference|#\s*source(Mapping)?URL|@license|@preserve)/

const LEGAL_COMMENT =
  /@license|@preserve|copyright|SPDX-License-Identifier|Apache License|\(c\) \d{4}/i

const bannerOption = [
  {
    type: "object",
    properties: { allowBanner: { type: "boolean" } },
    additionalProperties: false,
  },
]

function commentBody(comment) {
  return comment.value
    .replace(/^\/+/, "")
    .replace(/^\*+/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*+/, "").trim())
    .filter(Boolean)
    .join("\n")
}

function isFunctional(comment) {
  if (comment.type === "Shebang") return true
  if (comment.type === "Block" && comment.value.startsWith("!")) return true
  if (LEGAL_COMMENT.test(comment.value)) return true

  return FUNCTIONAL_COMMENT.test(commentBody(comment))
}

function isBanner(comment) {
  return BANNER_ART.test(comment.value)
}

function ownsLines(sourceCode, comment) {
  const before = sourceCode.lines[comment.loc.start.line - 1].slice(
    0,
    comment.loc.start.column,
  )
  const after = sourceCode.lines[comment.loc.end.line - 1].slice(
    comment.loc.end.column,
  )

  return before.trim() === "" && after.trim() === ""
}

function lineRange(sourceCode, startLine, endLine) {
  const start = sourceCode.getIndexFromLoc({ line: startLine, column: 0 })
  const end =
    endLine < sourceCode.lines.length
      ? sourceCode.getIndexFromLoc({ line: endLine + 1, column: 0 })
      : sourceCode.text.length

  return [start, end]
}

function removeComment(fixer, sourceCode, comment) {
  if (!ownsLines(sourceCode, comment)) return fixer.remove(comment)

  return fixer.removeRange(
    lineRange(sourceCode, comment.loc.start.line, comment.loc.end.line),
  )
}

function jsdocLines(comment) {
  let inTags = false

  return comment.value
    .slice(1)
    .split("\n")
    .map((raw) => {
      const text = raw.replace(/^\s*\*?\s?/, "").trim()
      if (text.startsWith("@")) inTags = true

      return { raw, text, isTag: inTags && text !== "" }
    })
}

function isJsdoc(comment) {
  return comment.type === "Block" && /^\*(?!\*)/.test(comment.value)
}

function isTagOnlyJsdoc(comment) {
  return (
    isJsdoc(comment) &&
    jsdocLines(comment).every((line) => line.text === "" || line.isTag)
  )
}

const blankLineAfterShebang = {
  meta: { type: "layout", fixable: "whitespace", schema: bannerOption },
  create(context) {
    const allowBanner = context.options[0]?.allowBanner ?? false

    return {
      Program() {
        const { lines } = context.sourceCode
        if (!lines[0]?.startsWith("#!") || lines.length < 2) return
        if (lines[1].trim() === "") return
        if (allowBanner && /^\s*(\/\/|\/\*)/.test(lines[1]) && BANNER_ART.test(lines[1])) return

        context.report({
          loc: { line: 1, column: 0 },
          message: "Expected a blank line after the shebang.",
          fix: (fixer) => fixer.insertTextAfterRange([0, lines[0].length], "\n"),
        })
      },
    }
  },
}

const noFileHeaderComment = {
  meta: { type: "suggestion", fixable: "code", schema: bannerOption },
  create(context) {
    const allowBanner = context.options[0]?.allowBanner ?? false
    const { sourceCode } = context

    return {
      Program(node) {
        const first = sourceCode.getFirstToken(node)
        if (!first) return

        const header = sourceCode
          .getAllComments()
          .filter((comment) => comment.range[0] < first.range[0])
          .filter((comment) => !isFunctional(comment))
          .filter((comment) => !isTagOnlyJsdoc(comment))
          .filter((comment) => !(allowBanner && isBanner(comment)))

        if (header.length === 0) return

        context.report({
          loc: { start: header[0].loc.start, end: header.at(-1).loc.end },
          message: "Remove the file header comment.",
          fix: (fixer) =>
            header.map((comment) => removeComment(fixer, sourceCode, comment)),
        })
      },
    }
  },
}

function dividerTitle(value) {
  if (DECORATION_ONLY.test(value)) return ""

  const dashed = value.match(DASH_WRAPPED_TITLE)
  if (dashed) return dashed[1]

  if (!BOX_RULE.test(value)) return null

  const stripped = value.replace(BOX_EDGES, "")
  if (stripped === value.trim() || BOX_RULE.test(stripped)) return null

  return stripped
}

const noDividerComment = {
  meta: { type: "suggestion", fixable: "code", schema: bannerOption },
  create(context) {
    const allowBanner = context.options[0]?.allowBanner ?? false
    const { sourceCode } = context

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type !== "Line") continue
          if (isFunctional(comment)) continue
          if (allowBanner && isBanner(comment)) continue

          const title = dividerTitle(comment.value)
          if (title === null) continue

          context.report({
            loc: comment.loc,
            message: "Remove the section divider comment.",
            fix: (fixer) =>
              title === ""
                ? removeComment(fixer, sourceCode, comment)
                : fixer.replaceText(comment, `// ${title}`),
          })
        }
      },
    }
  },
}

const noJsdocDescription = {
  meta: { type: "suggestion", fixable: "code", schema: [] },
  create(context) {
    const { sourceCode } = context

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (!isJsdoc(comment) || isFunctional(comment)) continue

          const lines = jsdocLines(comment)
          if (lines.every((line) => line.text === "" || line.isTag)) continue

          const tags = lines.filter((line) => line.isTag)
          const indent = sourceCode.lines[comment.loc.start.line - 1].slice(
            0,
            comment.loc.start.column,
          )

          context.report({
            loc: comment.loc,
            message: "Remove the JSDoc description; keep only type tags.",
            fix: (fixer) =>
              tags.length === 0
                ? removeComment(fixer, sourceCode, comment)
                : fixer.replaceText(
                    comment,
                    `/**\n${tags.map((line) => line.raw).join("\n")}\n${indent} */`,
                  ),
          })
        }
      },
    }
  },
}

const basePadding = stylistic.rules["padding-line-between-statements"]

function isGroupedCase(node) {
  if (node.type !== "SwitchCase") return false

  const cases = node.parent.cases
  const previous = cases[cases.indexOf(node) - 1]

  return previous !== undefined && previous.consequent.length === 0
}

const paddingLineBetweenStatements = {
  meta: basePadding.meta,
  create(context) {
    const { sourceCode } = context

    const report = (descriptor) => {
      const { node } = descriptor
      const before = sourceCode.getTokenBefore(node)
      const asiGuard =
        before?.value === ";" && before.loc.start.line === node.loc.start.line

      if (asiGuard || isGroupedCase(node)) return

      context.report(descriptor)
    }

    return basePadding.create(Object.create(context, { report: { value: report } }))
  },
}

export const styleRulesPlugin = {
  meta: { name: "extensiondev-style" },
  rules: {
    "padding-line-between-statements": paddingLineBetweenStatements,
    "blank-line-after-shebang": blankLineAfterShebang,
    "no-file-header-comment": noFileHeaderComment,
    "no-divider-comment": noDividerComment,
    "no-jsdoc-description": noJsdocDescription,
  },
}

const STYLE_FILES = ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"]

const STYLE_IGNORES = [
  "**/vendor/**",
  "**/__fixtures__/**",
  "**/__snapshots__/**",
  "**/fixtures/**",
  "**/store-corpus/**",
  "**/public/**",
  "**/generated/**",
  "**/*.generated.*",
  "**/*.gen.*",
  "**/*.min.js",
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
]

export const styleRules = [
  {
    name: "extensiondev/style",
    files: STYLE_FILES,
    ignores: STYLE_IGNORES,
    plugins: { "extensiondev-style": styleRulesPlugin },
    rules: {
      curly: ["error", "multi-line"],
      "extensiondev-style/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: ["return", "throw"] },
        { blankLine: "always", prev: "if", next: "*" },
        { blankLine: "any", prev: "if", next: "if" },
        { blankLine: "always", prev: "*", next: "block-like" },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "multiline-expression", next: "*" },
        { blankLine: "any", prev: "*", next: "empty" },
        { blankLine: "any", prev: "empty", next: "*" },
      ],
      "extensiondev-style/blank-line-after-shebang": ["error", { allowBanner: true }],
      "extensiondev-style/no-file-header-comment": ["error", { allowBanner: true }],
      "extensiondev-style/no-divider-comment": ["error", { allowBanner: true }],
      "extensiondev-style/no-jsdoc-description": "error",
    },
  },
]
