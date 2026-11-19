// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { parse as acornParse } from "acorn";

/* @invariant A GUARDED USE IS WHAT THE ENGINE CALLS GUARDED, BY THE SAME
 * RULE, PLUS A CHECK HELD IN A CONST. The source of truth is Extension.js
 * programs/develop/plugin-web-extension/feature-manifest/steps/apply-dev-defaults-lib/webkit-guarded-ranges.ts
 * (webkitGuardedRanges) and the member pattern of usesGeckoUnsupportedApi in
 * warn-gecko-unsupported-apis.ts beside it; extension-develop does not export
 * either, so the rule is ported here and changes only when the engine's does.
 * A span is guarded when a presence check on the missing namespace keeps it
 * closed (chrome.downloads?.download, if (chrome.downloads), typeof
 * chrome.downloads !== "undefined", 'downloads' in chrome, with !, Boolean(),
 * && and || folded), when an early exit on an open check precedes it, when a
 * try with a catch holds it, or when it is the body of an unexported function
 * referred to only from guarded spans. A const bound once in the file and
 * never assigned stands for its initializer in every test (const has = typeof
 * chrome.debugger !== "undefined"; if (!has) return), folded the same way;
 * ledger entry 491. A use is a member read through the
 * namespace (chrome.downloads.download); one written with optional chaining
 * on the namespace (chrome.downloads?.download) is guarded wherever it sits,
 * and a bare read of the namespace is the presence check itself, never a use.
 * A file the parser refuses yields no spans, so every use in it is unguarded.
 * A use left unguarded in a file that holds a presence check on the namespace
 * somewhere (a bare read outside a comment, 'downloads' in chrome, or an
 * optional chain through it) is checked: the validator cannot tie the check
 * to the call and warns instead of blocking. Ledger entries 251 and 491.
 */

export interface ApiUse {
  file: string;
  line: number;
  namespace: string;
  guarded: boolean;
  checked: boolean;
}

interface AstNode {
  type: string;
  [key: string]: unknown;
}

interface Range {
  start: number;
  end: number;
}

type Truth = "true" | "false" | undefined;

interface FunctionReference {
  offset: number;
  enclosing: string[];
}

interface NamedFunction {
  body: Range;
  references: FunctionReference[];
  exported: boolean;
}

interface PendingReference {
  name: string;
  reference: FunctionReference;
}

const MAX_PARSE_BYTES = 4 * 1024 * 1024;
const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window"]);
const EXTENSION_ROOTS = new Set(["chrome", "browser"]);
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const NON_CHILD_KEYS = new Set(["type", "start", "end", "loc", "range"]);

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function node(value: unknown): AstNode | undefined {
  return isNode(value) ? value : undefined;
}

function list(value: unknown): AstNode[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function children(value: AstNode): AstNode[] {
  const out: AstNode[] = [];

  for (const key of Object.keys(value)) {
    if (NON_CHILD_KEYS.has(key)) continue;

    const child = value[key];
    if (Array.isArray(child)) out.push(...child.filter(isNode));
    else if (isNode(child)) out.push(child);
  }

  return out;
}

function parse(source: string): AstNode | undefined {
  const shared = { ecmaVersion: "latest", allowAwaitOutsideFunction: true, allowHashBang: true } as const;
  const attempts = [
    { ...shared, sourceType: "script", allowReturnOutsideFunction: true },
    { ...shared, sourceType: "module" },
  ] as const;

  for (const options of attempts) {
    try {
      return acornParse(source, options) as unknown as AstNode;
    } catch {
      continue;
    }
  }

  return undefined;
}

function negate(value: Truth): Truth {
  if (value === "true") return "false";
  if (value === "false") return "true";

  return undefined;
}

function propertyName(member: AstNode): string | undefined {
  const property = node(member.property);
  if (!property) return undefined;
  if (!member.computed && property.type === "Identifier") return String(property.name);
  if (property.type === "Literal" && typeof property.value === "string") return property.value;

  return undefined;
}

function bindingNames(pattern: AstNode | undefined): string[] {
  if (!pattern) return [];

  switch (pattern.type) {
    case "Identifier":
      return [String(pattern.name)];
    case "ObjectPattern":
      return list(pattern.properties).flatMap((property) =>
        bindingNames(property.type === "RestElement" ? property : node(property.value)),
      );
    case "ArrayPattern":
      return list(pattern.elements).flatMap((element) => bindingNames(element));
    case "AssignmentPattern":
      return bindingNames(node(pattern.left));
    case "RestElement":
      return bindingNames(node(pattern.argument));
    default:
      return [];
  }
}

function memberPath(value: AstNode): string[] | undefined {
  let current: AstNode | undefined = value;
  const names: string[] = [];

  while (current) {
    if (current.type === "ChainExpression") {
      current = node(current.expression);
      continue;
    }

    if (current.type === "MemberExpression") {
      const name = propertyName(current);
      if (name === undefined) return undefined;

      names.unshift(name);
      current = node(current.object);
      continue;
    }

    if (current.type === "Identifier") {
      names.unshift(String(current.name));
      break;
    }

    return undefined;
  }

  if (names.length && GLOBAL_OBJECTS.has(names[0])) names.shift();

  return names.length && EXTENSION_ROOTS.has(names[0]) ? names : undefined;
}

class GuardedRangeScan {
  public readonly ranges: Range[] = [];
  public readonly functions = new Map<string, NamedFunction>();
  private readonly pending: PendingReference[] = [];
  private readonly constants = new Map<string, Truth>();

  constructor(program: AstNode, private readonly missing: ReadonlySet<string>) {
    this.collectConstants(program);
    this.visit(program, []);
    for (const { name, reference } of this.pending) this.functions.get(name)?.references.push(reference);
  }

  private collectConstants(program: AstNode): void {
    const declared = new Map<string, number>();
    const mutated = new Set<string>();
    const consts: Array<{ name: string; init: AstNode }> = [];

    const bind = (names: string[]): void => {
      for (const name of names) declared.set(name, (declared.get(name) ?? 0) + 1);
    };

    const walk = (current: AstNode | undefined): void => {
      if (!current) return;

      switch (current.type) {
        case "VariableDeclaration":
          for (const declarator of list(current.declarations)) {
            const id = node(declarator.id);
            const init = node(declarator.init);
            bind(bindingNames(id));
            if (current.kind === "const" && id?.type === "Identifier" && init) consts.push({ name: String(id.name), init });
          }

          break;
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
        case "ClassDeclaration":
        case "ClassExpression":
          bind(bindingNames(node(current.id)));
          for (const param of list(current.params)) bind(bindingNames(param));

          break;
        case "CatchClause":
          bind(bindingNames(node(current.param)));

          break;
        case "ImportSpecifier":
        case "ImportDefaultSpecifier":
        case "ImportNamespaceSpecifier":
          bind(bindingNames(node(current.local)));

          break;
        case "AssignmentExpression":
          for (const name of bindingNames(node(current.left))) mutated.add(name);

          break;
        case "UpdateExpression":
          for (const name of bindingNames(node(current.argument))) mutated.add(name);

          break;
        default:
          break;
      }

      for (const child of children(current)) walk(child);
    };

    walk(program);

    for (const { name, init } of consts) {
      if (declared.get(name) !== 1 || mutated.has(name)) continue;

      const truth = this.truth(init);
      if (truth) this.constants.set(name, truth);
    }
  }

  private namesMissing(path: string[]): boolean {
    return path.length >= 2 && this.missing.has(path[1]);
  }

  private readsMissing(value: AstNode): boolean {
    const path = memberPath(value);

    return path !== undefined && this.namesMissing(path);
  }

  private compared(left: AstNode, right: AstNode, operator: string): Truth {
    const equals = operator === "===" || operator === "==";
    const differs = operator === "!==" || operator === "!=";
    if (!equals && !differs) return undefined;

    const typeofMissing =
      left.type === "UnaryExpression" && left.operator === "typeof" && isNode(left.argument) && this.readsMissing(left.argument);

    if (typeofMissing && right.type === "Literal") return equals === (right.value === "undefined") ? "true" : "false";
    if (!this.readsMissing(left)) return undefined;

    const isUndefined =
      (right.type === "Identifier" && right.name === "undefined") ||
      (right.type === "UnaryExpression" && right.operator === "void" && node(right.argument)?.type === "Literal");

    if (isUndefined) return equals ? "true" : "false";

    if (right.type === "Literal" && right.value === null) {
      const loose = operator === "==" || operator === "!=";
      if (!loose) return equals ? "false" : "true";

      return equals ? "true" : "false";
    }

    return undefined;
  }

  private truth(test: AstNode | undefined): Truth {
    if (!test) return undefined;

    switch (test.type) {
      case "Identifier":
        return this.constants.get(String(test.name));
      case "ChainExpression":
      case "MemberExpression":
        return this.readsMissing(test) ? "false" : undefined;
      case "UnaryExpression":
        return test.operator === "!" ? negate(this.truth(node(test.argument))) : undefined;

      case "CallExpression": {
        const callee = node(test.callee);
        const argument = list(test.arguments)[0];

        return callee?.type === "Identifier" && callee.name === "Boolean" && argument ? this.truth(argument) : undefined;
      }

      case "BinaryExpression": {
        const left = node(test.left);
        const right = node(test.right);
        if (!left || !right) return undefined;

        if (test.operator === "in") {
          if (left.type !== "Literal" || typeof left.value !== "string") return undefined;

          const path = memberPath(right);

          return path && this.namesMissing([...path, left.value]) ? "false" : undefined;
        }

        return this.compared(left, right, String(test.operator)) ?? this.compared(right, left, String(test.operator));
      }

      case "LogicalExpression": {
        const left = this.truth(node(test.left));
        const right = this.truth(node(test.right));

        if (test.operator === "&&") {
          if (left === "false" || right === "false") return "false";

          return left === "true" && right === "true" ? "true" : undefined;
        }

        if (test.operator === "||") {
          if (left === "true" || right === "true") return "true";

          return left === "false" && right === "false" ? "false" : undefined;
        }

        return undefined;
      }

      default:
        return undefined;
    }
  }

  private add(value: AstNode | undefined): void {
    if (value) this.ranges.push({ start: Number(value.start), end: Number(value.end) });
  }

  private branch(test: AstNode | undefined, consequent: AstNode | undefined, alternate: AstNode | undefined): void {
    const truth = this.truth(test);
    if (truth === "false") this.add(consequent);
    if (truth === "true") this.add(alternate);
  }

  private declare(name: string, fn: AstNode, exported: boolean): void {
    const body = node(fn.body);
    if (!body) return;

    const known = this.functions.get(name);

    if (known) {
      known.exported = true;

      return;
    }

    this.functions.set(name, { body: { start: Number(body.start), end: Number(body.end) }, references: [], exported });
  }

  private refer(name: string, offset: number, enclosing: string[]): void {
    const reference = { offset, enclosing: [...enclosing] };
    const known = this.functions.get(name);
    if (known) known.references.push(reference);
    else this.pending.push({ name, reference });
  }

  private visitStatements(statements: AstNode[], enclosing: string[]): void {
    statements.forEach((statement, index) => {
      this.visit(statement, enclosing);

      if (
        statement.type === "IfStatement" &&
        this.truth(node(statement.test)) === "true" &&
        exitsAbruptly(node(statement.consequent)) &&
        index + 1 < statements.length
      ) {
        this.ranges.push({ start: Number(statements[index + 1].start), end: Number(statements[statements.length - 1].end) });
      }
    });
  }

  private visitDeclaration(declaration: AstNode, enclosing: string[], exported: boolean): void {
    if (declaration.type === "FunctionDeclaration") {
      const name = node(declaration.id)?.name;

      if (typeof name === "string") {
        this.declare(name, declaration, exported);
        this.visit(node(declaration.body), [...enclosing, name]);

        return;
      }
    }

    if (declaration.type !== "VariableDeclaration") {
      this.visit(declaration, enclosing);

      return;
    }

    for (const declarator of list(declaration.declarations)) {
      const id = node(declarator.id);
      const init = node(declarator.init);

      if (id?.type === "Identifier" && init && FUNCTION_TYPES.has(init.type)) {
        this.declare(String(id.name), init, exported);
        this.visit(init, [...enclosing, String(id.name)]);
        continue;
      }

      if (id?.type !== "Identifier") this.visit(id, enclosing);

      this.visit(init, enclosing);
    }
  }

  private visit(current: AstNode | undefined, enclosing: string[]): void {
    if (!current) return;

    switch (current.type) {
      case "Program":
      case "BlockStatement":
      case "StaticBlock":
        this.visitStatements(list(current.body), enclosing);

        return;
      case "FunctionDeclaration":
      case "VariableDeclaration":
        this.visitDeclaration(current, enclosing, false);

        return;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration": {
        const declaration = node(current.declaration);
        if (declaration) this.visitDeclaration(declaration, enclosing, true);

        for (const specifier of list(current.specifiers)) {
          const local = node(specifier.local);
          if (local?.type === "Identifier") this.refer(String(local.name), Number(local.start), []);
        }

        return;
      }

      case "IfStatement":
      case "ConditionalExpression": {
        const test = node(current.test);
        this.visit(test, enclosing);
        this.branch(test, node(current.consequent), node(current.alternate));
        this.visit(node(current.consequent), enclosing);
        this.visit(node(current.alternate), enclosing);

        return;
      }

      case "LogicalExpression": {
        const left = node(current.left);
        this.visit(left, enclosing);

        const truth = this.truth(left);

        if ((current.operator === "&&" && truth === "false") || (current.operator === "||" && truth === "true")) {
          this.add(node(current.right));
        }

        this.visit(node(current.right), enclosing);

        return;
      }

      case "WhileStatement":
      case "ForStatement": {
        const test = node(current.test);
        this.visit(node(current.init), enclosing);
        this.visit(test, enclosing);
        if (this.truth(test) === "false") this.add(node(current.body));

        this.visit(node(current.update), enclosing);
        this.visit(node(current.body), enclosing);

        return;
      }

      case "TryStatement":
        if (node(current.handler)) this.add(node(current.block));

        this.visit(node(current.block), enclosing);
        this.visit(node(current.handler), enclosing);
        this.visit(node(current.finalizer), enclosing);

        return;
      case "MemberExpression":
        this.visit(node(current.object), enclosing);
        if (current.computed) this.visit(node(current.property), enclosing);

        return;
      case "Property":
      case "MethodDefinition":
      case "PropertyDefinition":
        if (current.computed) this.visit(node(current.key), enclosing);

        this.visit(node(current.value), enclosing);

        return;
      case "LabeledStatement":
        this.visit(node(current.body), enclosing);

        return;
      case "Identifier":
        this.refer(String(current.name), Number(current.start), enclosing);

        return;
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "MetaProperty":
      case "BreakStatement":
      case "ContinueStatement":
        return;
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        for (const param of list(current.params)) this.visit(param, enclosing);

        this.visit(node(current.body), enclosing);

        return;
      default:
        for (const child of children(current)) this.visit(child, enclosing);
    }
  }
}

function exitsAbruptly(statement: AstNode | undefined): boolean {
  if (!statement) return false;

  switch (statement.type) {
    case "ReturnStatement":
    case "ThrowStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return true;
    case "BlockStatement":
      return list(statement.body).some((item) => exitsAbruptly(item));
    case "IfStatement":
      return exitsAbruptly(node(statement.consequent)) && exitsAbruptly(node(statement.alternate));
    default:
      return false;
  }
}

function covers(ranges: Range[], offset: number): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

function settleFunctions(scan: GuardedRangeScan): Range[] {
  const ranges = [...scan.ranges];
  const guarded = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;

    for (const [name, fn] of scan.functions) {
      if (guarded.has(name) || fn.exported) continue;

      const entries = fn.references.filter((reference) => !reference.enclosing.includes(name));
      if (!entries.length) continue;

      const unreachable = entries.every(
        (reference) => covers(ranges, reference.offset) || reference.enclosing.some((outer) => guarded.has(outer)),
      );
      if (!unreachable) continue;

      guarded.add(name);
      ranges.push(fn.body);
      changed = true;
    }
  }

  return ranges;
}

export function guardedRanges(source: string, missingNamespaces: ReadonlySet<string>): Range[] {
  if (source.length > MAX_PARSE_BYTES) return [];

  const program = parse(source);
  if (!program) return [];

  try {
    return settleFunctions(new GuardedRangeScan(program, missingNamespaces));
  } catch {
    return [];
  }
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;

  return line;
}

function inComment(source: string, offset: number): boolean {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const lead = source.slice(lineStart, offset).trimStart();

  return lead.startsWith("//") || lead.startsWith("*") || lead.startsWith("/*");
}

/* @invariant A SIMPLE ALIAS OF THE NAMESPACE IS THE NAMESPACE, AND ONLY A NAME
 * BOUND ONCE IN THE FILE IS AN ALIAS. The use pattern below reads chrome.
 * and browser. member calls alone, so on 2026-11-18 (ledger 944) const api =
 * globalThis.browser ?? chrome; api.contextMenus.create(...) validated as
 * valid for a Firefox build granted "menus" alone, where Firefox gives
 * browser.contextMenus only under "contextMenus". Before the scan, a name
 * declared with const, let or var from chrome or browser (bare or through
 * globalThis, self or window, joined by ?? or ||, or chosen by a typeof or
 * presence conditional) is rewritten to chrome wherever a member is read
 * through it, and a name destructured from the namespace or from such an
 * alias (const { contextMenus } = chrome, const { contextMenus: menu } =
 * api) to the member it stands for. This is text, not scope analysis, and a
 * TypeScript file never reaches the parser, so the rule errs to silence: a
 * name that the file binds anywhere else (a second declaration, a parameter,
 * a catch binding, an import, a destructuring or an object or array literal
 * that lists it) or assigns again is no alias at all, and neither is an
 * initializer that reads on past the namespace (chrome.runtime, chrome as
 * any). Lines are kept, so a use is reported on the line the source has it,
 * under the name the source writes (api.contextMenus).
 */
const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const ROOT = "(?:(?:globalThis|self|window)\\s*\\.\\s*)?(?:chrome|browser)(?![\\w$])";
const ROOT_TEST = `(?:typeof\\s+${ROOT}\\s*[!=]==?\\s*(?:"undefined"|'undefined')|${ROOT})`;
const ROOT_EXPRESSION = `(?:${ROOT_TEST}\\s*\\?\\s*${ROOT}\\s*:\\s*${ROOT}|${ROOT}(?:\\s*(?:\\?\\?|\\|\\|)\\s*${ROOT})*)`;
const ROOT_INITIALIZER = `(?:\\(\\s*${ROOT_EXPRESSION}\\s*\\)|${ROOT_EXPRESSION})`;
const TYPE_ANNOTATION = "(?::[^=;\\n]+)?";
const ROOT_ALIAS = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+(${IDENTIFIER})\\s*${TYPE_ANNOTATION}=\\s*${ROOT_INITIALIZER}`, "g");
const DESTRUCTURED = new RegExp(
  `(?<![\\w$.])(?:const|let|var)\\s*\\{([^{}=]*)\\}\\s*${TYPE_ANNOTATION}=\\s*(?:(${ROOT_INITIALIZER})|(${IDENTIFIER}))`,
  "g",
);
const ALIAS_HINT = /\b(?:const|let|var)\b[^=;\n]*=\s*\(?\s*(?:typeof\s+)?(?:(?:globalThis|self|window)\s*\.\s*)?(?:chrome|browser)\b|\b(?:const|let|var)\s*\{/;

interface AliasDeclaration extends Range {
  name: string;
  root: string;
  member?: string;
}

export interface ResolvedAliases {
  source: string;
  written: Map<number, string>;
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function endsDeclaration(source: string, at: number): boolean {
  const rest = source.slice(at, at + 400);
  const sameLine = /^[ \t]*([^ \t\r\n])/.exec(rest)?.[1];

  if (sameLine !== undefined) return sameLine === ";" || sameLine === "," || /^[ \t]*\/[/*]/.test(rest);

  const next = /^\s*(\S)/.exec(rest)?.[1];
  if (next === undefined || next === ";") return true;
  if (/^\s*\/[/*]/.test(rest)) return true;

  return !/[.?([|&=+\-*/<>!:%^,`]/.test(next);
}

function rootWrittenIn(initializer: string): string {
  return /\bchrome\b/.test(initializer) ? "chrome" : "browser";
}

function takenAsParameter(text: string, name: string): boolean {
  const lists = /\(([^()]*)\)\s*(=>|\{|:)/g;
  const parameter = new RegExp(`(?:^|,)\\s*(?:\\.\\.\\.\\s*)?${escapeForPattern(name)}\\s*(?:[:=?][^,]*)?(?:,|$)`);

  for (let match = lists.exec(text); match !== null; match = lists.exec(text)) {
    if (!parameter.test(match[1])) continue;
    if (match[2] === "=>") return true;
    if (!/(?:^|[^\w$.])(?:if|while|for|switch|with)\s*$/.test(text.slice(Math.max(0, match.index - 16), match.index))) return true;
  }

  return false;
}

function boundOnce(source: string, name: string, declared: Range): boolean {
  const text = `${source.slice(0, declared.start)}${" ".repeat(declared.end - declared.start)}${source.slice(declared.end)}`;
  const escaped = escapeForPattern(name);
  const word = `(?<![\\w$.])${escaped}(?![\\w$])`;
  const boundOrAssigned = [
    `(?<![\\w$.])(?:const|let|var|function(?:\\s+|\\s*\\*\\s*)|class|import|type|interface|enum|namespace|as)\\s*${word}`,
    `${word}\\s*(?:=(?![=>])|\\+\\+|--|[-+*/%&|^]=|\\?\\?=|\\|\\|=|&&=|<<=|>>=|\\*\\*=)`,
    `(?:\\+\\+|--)\\s*${word}`,
    `${word}\\s*=>`,
    `[{,[]\\s*(?:\\.\\.\\.\\s*)?(?:${IDENTIFIER}\\s*:\\s*)?${word}\\s*(?:=[^,}\\]]*)?[,}\\]]`,
    `catch\\s*\\(\\s*${escaped}\\s*\\)`,
  ];

  return !boundOrAssigned.some((pattern) => new RegExp(pattern).test(text)) && !takenAsParameter(text, name);
}

function aliasDeclarations(source: string): AliasDeclaration[] {
  const found: AliasDeclaration[] = [];
  const roots = new Map<string, string>();

  ROOT_ALIAS.lastIndex = 0;

  for (let match = ROOT_ALIAS.exec(source); match !== null; match = ROOT_ALIAS.exec(source)) {
    const name = match[1];
    const declared = { start: match.index, end: match.index + match[0].length };
    if (EXTENSION_ROOTS.has(name) || !endsDeclaration(source, declared.end) || !boundOnce(source, name, declared)) continue;

    roots.set(name, name);
    found.push({ ...declared, name, root: name });
  }

  DESTRUCTURED.lastIndex = 0;

  for (let match = DESTRUCTURED.exec(source); match !== null; match = DESTRUCTURED.exec(source)) {
    const declared = { start: match.index, end: match.index + match[0].length };
    const root = match[2] ? rootWrittenIn(match[2]) : roots.has(match[3]) ? "chrome" : undefined;
    if (!root || !endsDeclaration(source, declared.end)) continue;

    for (const part of match[1].split(",")) {
      const property = new RegExp(`^\\s*(${IDENTIFIER})(?:\\s*:\\s*(${IDENTIFIER}))?\\s*$`).exec(part);
      if (!property) continue;

      const name = property[2] ?? property[1];
      if (EXTENSION_ROOTS.has(name) || roots.has(name) || !boundOnce(source, name, declared)) continue;

      found.push({ ...declared, name, root, member: property[1] });
    }
  }

  return found;
}

export function resolveNamespaceAliases(source: string): ResolvedAliases {
  const written = new Map<number, string>();
  if (source.length > MAX_PARSE_BYTES || !ALIAS_HINT.test(source)) return { source, written };

  const declarations = aliasDeclarations(source);
  if (!declarations.length) return { source, written };

  const edits: Array<Range & { text: string; alias?: string }> = [];

  for (const declaration of declarations) {
    const escaped = escapeForPattern(declaration.name);
    const reads = declaration.member
      ? new RegExp(`(?<![\\w$.'"\`])${escaped}(?![\\w$'"\`])(?!\\s*:)`, "g")
      : new RegExp(`(?<![\\w$.'"\`])${escaped}(?=\\s*(?:\\?\\.|\\.)\\s*[A-Za-z_$])|(?<=['"\`]\\s+in\\s+)${escaped}(?![\\w$])`, "g");

    for (let match = reads.exec(source); match !== null; match = reads.exec(source)) {
      if (covers(declarations, match.index)) continue;

      edits.push({
        start: match.index,
        end: match.index + match[0].length,
        text: declaration.member ? `${declaration.root}.${declaration.member}` : "chrome",
        ...(declaration.member ? {} : { alias: declaration.name }),
      });
    }
  }

  if (!edits.length) return { source, written };

  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;

  for (const edit of edits) {
    if (edit.start < at) continue;

    out += source.slice(at, edit.start);
    if (edit.alias) written.set(out.length, edit.alias);

    out += edit.text;
    at = edit.end;
  }

  return { source: out + source.slice(at), written };
}

export function apiUsesIn(file: string, original: string, api: string): ApiUse[] {
  const { source, written } = resolveNamespaceAliases(original);
  const re = new RegExp(`\\b(chrome|browser)\\s*\\.\\s*${api}(?![\\w$])\\s*(\\?\\.|\\.\\s*[A-Za-z_$])?`, "g");
  const inCheck = new RegExp(`['"\`]${api}['"\`]\\s+in\\s+(?:chrome|browser)\\b`);
  const uses: ApiUse[] = [];
  let ranges: Range[] | undefined;
  let checked = inCheck.test(source);

  for (let match = re.exec(source); match !== null; match = re.exec(source)) {
    const namespace = written.get(match.index) ?? match[1];
    const tail = match[2];

    if (!tail) {
      if (!inComment(source, match.index)) checked = true;

      continue;
    }

    if (tail === "?.") checked = true;

    ranges ??= guardedRanges(source, new Set([api]));
    uses.push({
      file,
      line: lineAt(source, match.index),
      namespace,
      guarded: tail === "?." || covers(ranges, match.index),
      checked: false,
    });
  }

  for (const use of uses) use.checked = checked;

  return uses;
}
