import { describe, expect, it } from "vitest";

import { schema } from "../tools/auth";
import { loginToProject } from "../tools/login";

describe("extension_auth login names where the project slug lives", () => {
  it("points a malformed project at the console address bar and extension.dev/new", async () => {
    const result = JSON.parse(await loginToProject({ project: "not-a-slug" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bad-request");
    expect(result.error.code).toBe("E_BAD_REQUEST");
    expect(result.error.message).toContain(
      "console.extension.dev/<workspace>/<project>",
    );
    expect(result.error.message).toMatch(/extension\.dev\/new/);
  });

  it("gives a missing project argument the same remedy", async () => {
    const result = JSON.parse(await loginToProject({ project: "" }));

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain(
      "console.extension.dev/<workspace>/<project>",
    );
  });

  it("teaches the slug's location in the login input schema itself", () => {
    const project = schema.inputSchema.properties.project as {
      description: string;
    };
    expect(project.description).toContain("console.extension.dev");
    expect(project.description).toMatch(/extension\.dev\/new/);
  });
});
