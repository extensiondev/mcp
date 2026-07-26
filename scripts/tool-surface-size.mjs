// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const binPath = fileURLToPath(new URL("../bin/extension-mcp.js", import.meta.url));

function listTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for tools/list"));
    }, 30000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
          );
        }
        if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(message.result.tools);
        }
      }
    });

    child.on("error", reject);

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "tool-surface-size", version: "0" },
        },
      })}\n`,
    );
  });
}

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

const tools = await listTools();
const rows = tools
  .map((tool) => ({
    name: tool.name,
    name_b: Buffer.byteLength(tool.name, "utf8"),
    desc_b: Buffer.byteLength(tool.description ?? "", "utf8"),
    schema_b: bytes(tool.inputSchema ?? {}),
    total_b: bytes(tool),
  }))
  .sort((a, b) => b.total_b - a.total_b);

const totals = rows.reduce(
  (acc, row) => ({
    name_b: acc.name_b + row.name_b,
    desc_b: acc.desc_b + row.desc_b,
    schema_b: acc.schema_b + row.schema_b,
    total_b: acc.total_b + row.total_b,
  }),
  { name_b: 0, desc_b: 0, schema_b: 0, total_b: 0 },
);

const wireBytes = bytes({ tools });
const tokens = (n) => Math.round(n / 4);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ rows, totals, wireBytes }, null, 2));
} else {
  const pad = (value, width) => String(value).padStart(width);
  console.log(`tools: ${rows.length}`);
  console.log(
    `${"tool".padEnd(34)}${pad("desc", 8)}${pad("schema", 8)}${pad("total", 8)}`,
  );
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(34)}${pad(row.desc_b, 8)}${pad(row.schema_b, 8)}${pad(row.total_b, 8)}`,
    );
  }
  console.log("");
  console.log(`description bytes: ${totals.desc_b}  (~${tokens(totals.desc_b)} tokens)`);
  console.log(`schema bytes:      ${totals.schema_b}  (~${tokens(totals.schema_b)} tokens)`);
  console.log(`name bytes:        ${totals.name_b}`);
  console.log(
    `tools/list wire:   ${wireBytes} bytes  (~${tokens(wireBytes)} tokens)`,
  );
}
