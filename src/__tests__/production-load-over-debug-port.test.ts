import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { productionLaunchEvidence, readLoadOverDebugPort } from "../lib/production-launch";

const ID = "fmhfemkaalplhcedidcihmjfeniembgf";
const servers: http.Server[] = [];

function debugPort(targets: Array<{ type: string; url: string }>): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(targets.map((t, i) => ({ id: `t${i}`, title: "", webSocketDebuggerUrl: "", ...t }))));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const contract = (cdpPort: number | undefined) => ({ browserPid: process.pid, extensionId: ID, ...(cdpPort ? { cdpPort } : {}) }) as never;

describe("a production launch reads the load off the browser's debug port when the contract names it", () => {
  it("confirms the load when a target of the extension is live", async () => {
    const port = await debugPort([{ type: "service_worker", url: `chrome-extension://${ID}/background/service_worker.js` }]);
    const c = contract(port);
    const out = await readLoadOverDebugPort(c, productionLaunchEvidence(c));
    expect(out.extensionLoaded).toBe(true);
    expect(out.loadEvidence).toMatch(new RegExp(`debug port ${port}: 1 live target of ${ID} \\(service_worker\\)`));
  });

  it("leaves the load unread when the port answers with no target of this extension", async () => {
    const port = await debugPort([{ type: "page", url: "chrome://newtab/" }]);
    const c = contract(port);
    const out = await readLoadOverDebugPort(c, productionLaunchEvidence(c));
    expect(out.extensionLoaded).toBeNull();
    expect(out.loadEvidence).toMatch(/neither proves nor refutes/);
  });

  it("keeps the old answer for an engine that names no debug port", async () => {
    const c = contract(undefined);
    const out = await readLoadOverDebugPort(c, productionLaunchEvidence(c));
    expect(out.extensionLoaded).toBeNull();
    expect(out.loadEvidence).toMatch(/no debug port/);
  });
});
