// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

import { CDPConnection } from "./cdp-connection";
import {
  PAGE_HTML_SCRIPT,
  PAGE_META_SCRIPT,
  EXTENSION_ROOT_META_SCRIPT,
  probeSelectorsScript,
  domSnapshotScript,
} from "./cdp-page-scripts";

export class CDPClient extends CDPConnection {
  static async discoverBrowserWsUrl(
    port: number,
    host = "127.0.0.1",
  ): Promise<string> {
    const res = await fetch(`http://${host}:${port}/json/version`);
    if (!res.ok) throw new Error(`CDP /json/version failed: ${res.status}`);

    const data = (await res.json()) as Record<string, unknown>;

    if (typeof data.webSocketDebuggerUrl === "string") {
      return data.webSocketDebuggerUrl;
    }

    throw new Error("No webSocketDebuggerUrl in /json/version response");
  }

  static async discoverTargets(
    port: number,
    host = "127.0.0.1",
  ): Promise<
    Array<{
      id: string;
      type: string;
      url: string;
      title: string;
      webSocketDebuggerUrl: string;
    }>
  > {
    const res = await fetch(`http://${host}:${port}/json`);
    if (!res.ok) throw new Error(`CDP /json failed: ${res.status}`);

    return (await res.json()) as Array<{
      id: string;
      type: string;
      url: string;
      title: string;
      webSocketDebuggerUrl: string;
    }>;
  }

  async getTargets(): Promise<Array<Record<string, unknown>>> {
    const response = (await this.sendCommand("Target.getTargets")) as
      | { targetInfos?: Array<Record<string, unknown>> }
      | undefined;

    return response?.targetInfos ?? [];
  }

  async attachToTarget(targetId: string): Promise<string> {
    const response = (await this.sendCommand("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId?: string };

    return response.sessionId ?? "";
  }

  async enableDomains(sessionId: string): Promise<void> {
    await Promise.all([
      this.sendCommand("Runtime.enable", {}, sessionId),
      this.sendCommand("Log.enable", {}, sessionId),
      this.sendCommand("Page.enable", {}, sessionId),
    ]);
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    await this.sendCommand("Page.navigate", { url }, sessionId);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);

      const unsubscribe = this.onEvent((msg) => {
        if (msg.method === "Page.loadEventFired") {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  async evaluate(sessionId: string, expression: string): Promise<unknown> {
    const response = (await this.sendCommand(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: false },
      sessionId,
    )) as { result?: { value?: unknown; exceptionDetails?: unknown } };

    return response.result?.value;
  }

  async getPageHTML(sessionId: string): Promise<string> {
    const result = await this.evaluate(sessionId, PAGE_HTML_SCRIPT);
    return typeof result === "string" ? result : "";
  }

  async getClosedShadowRoots(
    sessionId: string,
    maxBytes = 65536,
  ): Promise<
    Array<{ host: string; type: string; html: string; truncated?: boolean }>
  > {
    await this.sendCommand("DOM.enable", {}, sessionId);
    const doc = (await this.sendCommand(
      "DOM.getDocument",
      { depth: -1, pierce: true },
      sessionId,
    )) as { root?: unknown };

    const found: Array<{ nodeId: number; host: string; type: string }> = [];
    const walk = (node: any, hostName: string): void => {
      if (!node || typeof node !== "object") return;
      const name = node.localName || node.nodeName || hostName;
      if (Array.isArray(node.shadowRoots)) {
        for (const sr of node.shadowRoots) {
          if (
            sr &&
            sr.shadowRootType === "closed" &&
            typeof sr.nodeId === "number"
          ) {
            found.push({
              nodeId: sr.nodeId,
              host: String(name),
              type: "closed",
            });
          }
          walk(sr, name);
        }
      }
      if (Array.isArray(node.children))
        for (const c of node.children) walk(c, name);
      if (node.contentDocument) walk(node.contentDocument, name);
    };
    walk((doc as any).root, "html");

    const out: Array<{
      host: string;
      type: string;
      html: string;
      truncated?: boolean;
    }> = [];
    for (const f of found) {
      try {
        const oh = (await this.sendCommand(
          "DOM.getOuterHTML",
          { nodeId: f.nodeId },
          sessionId,
        )) as { outerHTML?: string };
        let html = String(oh?.outerHTML ?? "");
        let truncated = false;
        if (maxBytes > 0 && html.length > maxBytes) {
          html = html.slice(0, maxBytes);
          truncated = true;
        }
        out.push({
          host: f.host,
          type: f.type,
          html,
          ...(truncated ? { truncated } : {}),
        });
      } catch {
        out.push({ host: f.host, type: f.type, html: "" });
      }
    }
    return out;
  }

  async getPageMeta(sessionId: string): Promise<Record<string, unknown>> {
    const result = await this.evaluate(sessionId, PAGE_META_SCRIPT);
    return (result as Record<string, unknown>) ?? {};
  }

  async probeSelectors(
    sessionId: string,
    selectors: string[],
  ): Promise<
    Array<{
      selector: string;
      count: number;
      samples: Array<Record<string, unknown>>;
    }>
  > {
    const result = await this.evaluate(
      sessionId,
      probeSelectorsScript(selectors),
    );
    return (
      (result as Array<{
        selector: string;
        count: number;
        samples: Array<Record<string, unknown>>;
      }>) ?? []
    );
  }

  async getDomSnapshot(
    sessionId: string,
    maxNodes = 500,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.evaluate(sessionId, domSnapshotScript(maxNodes));
    return (result as Array<Record<string, unknown>>) ?? [];
  }

  async getExtensionRootMeta(
    sessionId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.evaluate(sessionId, EXTENSION_ROOT_META_SCRIPT);
    return (result as Record<string, unknown>) ?? null;
  }
}
