import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [tool, args] = [process.argv[2], JSON.parse(process.argv[3] || "{}")];
const env = { ...process.env }; delete env.EXTENSION_DEV_API_URL; delete env.XDG_CONFIG_HOME;
const t = new StdioClientTransport({ command: "node", args: ["bin/extension-mcp.js", "--features=local,platform"], env, cwd: process.cwd() });
const c = new Client({ name: "coordinator", version: "1" }); await c.connect(t);
const r = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 600000 });
for (const x of r.content) if (x.type === "text") { try { const j = JSON.parse(x.text); console.log(JSON.stringify({ ok: j.ok, status: j.status, value: j.value, error: j.error, hint: j.hint }, null, 1).slice(0, 3000)); } catch { console.log(x.text.slice(0, 3000)); } }
await c.close();
