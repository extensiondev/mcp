import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { productionDebugPortOutlook, productionLaunchEvidence, readLoadOverDebugPort } from "../lib/production-launch";

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

  it("keeps the old answer, naming the engine and the floor, for an engine older than 4.1.34, which opens no debug port", async () => {
    const c = { browserPid: process.pid, extensionId: ID, toolchainVersion: "4.1.33" } as never;
    const out = await readLoadOverDebugPort(c, productionLaunchEvidence(c));
    expect(out.extensionLoaded).toBeNull();
    expect(out.loadEvidence).toMatch(/this engine \(Extension\.js 4\.1\.33\) opens no debug port on a production run \(4\.1\.34 is the first that does\), so the browser's target list cannot be read from here, and only extension_dev proves the load/);
  });
});

describe("a production launch says the debug port will be read instead of claiming it opens none", () => {
  it("says extension_wait reads the load off the debug port when the contract's engine is 4.1.34 or later", () => {
    const out = productionLaunchEvidence({ command: "start", toolchainVersion: "4.1.36" } as never);

    expect(out.extensionLoaded).toBeNull();
    expect(out.loadEvidence).not.toMatch(/opens no debug port/);
    expect(out.loadEvidence).toMatch(/the engine \(Extension\.js 4\.1\.36\) stamps the browser's debug port \(cdpPort\) in the contract once the browser binds it, and extension_wait reads the load off that port's target list/);
    expect(out.loadEvidence).toMatch(/Beyond that, a production session has no hot reload and carries no dev bridge, so extension_logs has no console stream for it and the bridge verbs \(extension_storage, extension_reload, extension_open with a surface, extension_dom_snapshot by tab and extension_eval\) need allowControl: true\./);
  });

  it("treats a run that asked for allowControl as an engine that opens the port, since older engines refuse the flag", () => {
    const out = productionLaunchEvidence(null, true);

    expect(out.loadEvidence).toMatch(/Extension\.js 4\.1\.34 or later, the engines that take allowControl/);
    expect(out.loadEvidence).not.toMatch(/opens no debug port/);
    expect(out.loadEvidence).toMatch(/this session carries the control channel/);
  });

  it("says what it relies on when neither the contract nor the flag names the engine", () => {
    const out = productionLaunchEvidence(null);

    expect(out.loadEvidence).toMatch(/once the contract stamps cdpPort, which Extension\.js 4\.1\.34 or later does on a production run; an older engine never stamps it, and only extension_dev proves the load there/);
    expect(out.loadEvidence).not.toMatch(/opens no debug port/);
  });

  it("reads the outlook off the contract's engine version first, then the control channel", () => {
    expect(productionDebugPortOutlook({ toolchainVersion: "4.1.34" } as never)).toEqual({ kind: "opens", version: "4.1.34" });
    expect(productionDebugPortOutlook({ toolchainVersion: "4.1.33" } as never)).toEqual({ kind: "never", version: "4.1.33" });
    expect(productionDebugPortOutlook({ toolchainVersion: "4.1.37-canary.1793360022.4f7af0f6" } as never)).toEqual({ kind: "opens", version: "4.1.37-canary.1793360022.4f7af0f6" });
    expect(productionDebugPortOutlook({ controlPort: 61234 } as never)).toEqual({ kind: "opens", version: null });
    expect(productionDebugPortOutlook(null, true)).toEqual({ kind: "opens", version: null });
    expect(productionDebugPortOutlook(null)).toEqual({ kind: "unknown" });
    expect(productionDebugPortOutlook({ toolchainVersion: "not a version" } as never)).toEqual({ kind: "unknown" });
  });
});
