// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../index";
import { parseBatchCreateArgs } from "../lib/project-create-batch";
import { handler as auth } from "../tools/auth";
import { handler as projectCreate } from "../tools/project-create";

const fetchSpy = vi.fn(async () => {
  throw new Error("the network must not be reached for a malformed ref");
});

vi.stubGlobal("fetch", fetchSpy);

afterEach(() => {
  fetchSpy.mockClear();
});

describe("a project or repo ref with a space is refused where it enters, by isProjectRef", () => {
  it("extension_auth login refuses 'acme/my app' before any device code is requested", async () => {
    const out = JSON.parse(await auth({ action: "login", project: "acme/my app" }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("bad-request");
    expect(out.error.message).toContain("<workspace>/<project>");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("extension_project_create refuses the project ref and the repo ref alike", async () => {
    const project = JSON.parse(
      await projectCreate({ project: "acme/my app", repo: "octo/widget" } as never),
    );
    expect(project.status).toBe("bad-request");
    expect(project.error.message).toContain("<workspace>/<project>");

    const repo = JSON.parse(
      await projectCreate({ project: "acme/widget", repo: "octo/my repo" } as never),
    );
    expect(repo.status).toBe("bad-request");
    expect(repo.error.message).toContain("<owner>/<repo>");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a create list refuses a repo with a space", () => {
    const out = parseBatchCreateArgs({
      projects: [{ project: "acme/alpha", repo: "octo/my repo" }],
    } as never);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("<owner>/<repo>");
  });

  it("the login command prints usage for 'acme/my app' and reaches no server", async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));

      return true;
    }) as never);

    try {
      const code = await runCli("login", ["--project", "acme/my app"]);
      expect(code).toBe(1);
      expect(lines.join("")).toContain("Usage: extension-mcp login --project <workspace>/<project>");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
