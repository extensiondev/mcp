// A hand-rolled checker for the one flat schema this package pins. ajv would be
// a fifth runtime dependency for eight keys, so the schema is walked directly.

export interface JsonSchema {
  required?: string[];
  properties?: Record<string, any>;
  additionalProperties?: boolean;
}

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
};

const matchesType = (value: unknown, expected: string | string[]): boolean => {
  const wanted = Array.isArray(expected) ? expected : [expected];
  const actual = typeOf(value);
  return wanted.some(
    (type) =>
      type === actual || (type === "number" && actual === "integer"),
  );
};

function checkNode(value: unknown, node: any, path: string): string[] {
  const problems: string[] = [];
  if (!node || typeof node !== "object") return problems;

  if ("const" in node && value !== node.const) {
    problems.push(`${path}: expected ${JSON.stringify(node.const)}`);
  }

  if (node.oneOf) {
    const passing = node.oneOf.filter(
      (branch: any) => checkNode(value, branch, path).length === 0,
    );
    if (passing.length !== 1) {
      problems.push(`${path}: matched ${passing.length} of oneOf, wanted 1`);
    }
    return problems;
  }

  if (node.type && !matchesType(value, node.type)) {
    problems.push(`${path}: expected ${node.type}, got ${typeOf(value)}`);
    return problems;
  }

  if (node.type === "string") {
    if (node.minLength != null && (value as string).length < node.minLength) {
      problems.push(`${path}: shorter than ${node.minLength}`);
    }
    if (node.pattern && !new RegExp(node.pattern).test(value as string)) {
      problems.push(`${path}: does not match ${node.pattern}`);
    }
  }

  if (node.type === "array" && node.items) {
    (value as unknown[]).forEach((item, i) => {
      problems.push(...checkNode(item, node.items, `${path}[${i}]`));
    });
  }

  if (node.type === "object" || node.properties || node.required) {
    if (typeOf(value) !== "object") return problems;
    const record = value as Record<string, unknown>;
    for (const key of node.required ?? []) {
      if (!(key in record)) problems.push(`${path}: missing "${key}"`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (key in record) {
        problems.push(...checkNode(record[key], child, `${path}.${key}`));
      }
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(node.properties && key in node.properties)) {
          problems.push(`${path}: unexpected "${key}"`);
        }
      }
    }
  }

  return problems;
}

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
): string[] {
  return checkNode(value, schema, "$");
}
