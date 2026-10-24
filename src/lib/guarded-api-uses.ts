// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { parse as acornParse } from "acorn";

/* @invariant A GUARDED USE IS WHAT THE ENGINE CALLS GUARDED, BY THE SAME
 * RULE. The source of truth is Extension.js
 * programs/develop/plugin-web-extension/feature-manifest/steps/apply-dev-defaults-lib/webkit-guarded-ranges.ts
 * (webkitGuardedRanges) and the member pattern of usesGeckoUnsupportedApi in
 * warn-gecko-unsupported-apis.ts beside it; extension-develop does not export
 * either, so the rule is ported here and changes only when the engine's does.
 * A span is guarded when a presence check on the missing namespace keeps it
 * closed (chrome.downloads?.download, if (chrome.downloads), typeof
 * chrome.downloads !== "undefined", 'downloads' in chrome, with !, Boolean(),
 * && and || folded), when an early exit on an open check precedes it, when a
 * try with a catch holds it, or when it is the body of an unexported function
 * referred to only from guarded spans. A use is a member read through the
 * namespace (chrome.downloads.download); one written with optional chaining
 * on the namespace (chrome.downloads?.download) is guarded wherever it sits,
 * and a bare read of the namespace is the presence check itself, never a use.
 * A file the parser refuses yields no spans, so every use in it is unguarded.
 * Ledger entry 251.
 */

export interface ApiUse {
  file: string;
  line: number;
  guarded: boolean;
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

  constructor(program: AstNode, private readonly missing: ReadonlySet<string>) {
    this.visit(program, []);
    for (const { name, reference } of this.pending) this.functions.get(name)?.references.push(reference);
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

export function apiUsesIn(file: string, source: string, api: string): ApiUse[] {
  const re = new RegExp(`\\b(?:chrome|browser)\\s*\\.\\s*${api}(?![\\w$])\\s*(\\?\\.|\\.\\s*[A-Za-z_$])?`, "g");
  const uses: ApiUse[] = [];
  let ranges: Range[] | undefined;

  for (let match = re.exec(source); match !== null; match = re.exec(source)) {
    const tail = match[1];
    if (!tail) continue;

    ranges ??= guardedRanges(source, new Set([api]));
    uses.push({ file, line: lineAt(source, match.index), guarded: tail === "?." || covers(ranges, match.index) });
  }

  return uses;
}
