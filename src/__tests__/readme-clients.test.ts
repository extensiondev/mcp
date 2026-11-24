import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderReadmeSetup, spliceReadmeSetup } from "../clients/readme";
import snapshot from "../lib/templates-meta.snapshot.json";

const readmePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "README.md",
);

describe("the README setup is generated from src/clients", () => {
  it("matches the recipes (run pnpm readme:clients to regenerate)", () => {
    const readme = fs.readFileSync(readmePath, "utf8");
    const current = spliceReadmeSetup(readme);

    if (process.env.UPDATE_README === "1") {
      fs.writeFileSync(readmePath, current);

      return;
    }

    expect(readme).toBe(current);
  });

  it("never tells anyone to turn approvals off", () => {
    expect(renderReadmeSetup()).not.toMatch(/APPROVAL_GATE=0/);
  });

  it("783: gives one install command and one shared config, each the recipe docs/clients.json carries, and one-click badges for Cursor and VS Code", () => {
    const setup = renderReadmeSetup();
    const documented = JSON.parse(fs.readFileSync(path.resolve(path.dirname(readmePath), "docs", "clients.json"), "utf8")) as {
      clients: Array<{ id: string; recipes: { everything: { command?: string; config?: { text: string } } } }>;
    };
    const everything = (id: string) => documented.clients.find((client) => client.id === id)!.recipes.everything;

    expect(setup.match(/```bash/g)).toHaveLength(1);
    expect(everything("claude-code").command).toBe("claude mcp add extension-dev -- npx -y @extension.dev/mcp --features=local,platform");
    expect(setup).toContain(`\`\`\`bash\n${everything("claude-code").command}\n\`\`\``);
    expect(setup).toContain(`\`\`\`json\n${everything("json").config!.text}\n\`\`\``);
    expect(setup).toContain("/plugin marketplace add extensiondev/skill\n/plugin install extension-dev@extensiondev");
    expect(setup).toContain("](https://cursor.com/en/install-mcp?name=extension-dev&config=");
    expect(setup).toContain("](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22extension-dev%22");
  });
});

describe("the README tables state what the repository's own data says", () => {
  const readme = fs.readFileSync(readmePath, "utf8");

  it("connects Codex the way docs/clients.json does", () => {
    const documented = JSON.parse(fs.readFileSync(path.resolve(path.dirname(readmePath), "docs", "clients.json"), "utf8")) as {
      clients: Array<{ id: string; recipes: { everything: { command: string; config: { path: string } } } }>;
    };
    const codex = documented.clients.find((client) => client.id === "codex")!.recipes.everything;
    const row = readme.split("\n").find((line) => line.includes("| **Codex** |")) ?? "";
    const named = [...row.split("|")[3].matchAll(/`([^`]+)`/g)].map((match) => match[1]);

    expect(named).toEqual([codex.command.split(" -- ")[0].replace(" extension-dev", ""), codex.config.path]);
  });

  it("counts each framework's templates as the bundled catalog does, a TypeScript template being one with a tsconfig.json", () => {
    const counted: Record<string, number> = {};

    for (const template of snapshot.templates) {
      const framework = template.uiFramework || (template.configFiles.includes("tsconfig.json") ? "typescript" : "javascript");
      counted[framework] = (counted[framework] ?? 0) + 1;
    }

    const stated = Object.fromEntries([...readme.matchAll(/\| \*\*(\w+)\*\* \((\d+) templates\) \|/g)].map((match) => [match[1].toLowerCase(), Number(match[2])]));

    expect(stated).toEqual(counted);
    expect(Number(/from (\d+)\+ \[templates\]/.exec(readme)?.[1])).toBeLessThanOrEqual(snapshot.templates.length);
  });
});
