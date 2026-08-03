import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/templates-cache", () => ({
  listTemplates: async () => [
    {
      slug: "content-react",
      description: "A content script starter",
      uiFramework: "react",
      surfaces: ["content"],
      tags: ["react"],
      difficulty: "beginner",
      featured: true,
      useCases: [],
      repositoryUrl:
        "https://github.com/extension-js/examples/tree/abc/examples/content-react",
      downloads: { chrome: "https://example.com/content-react-chrome.zip" },
    },
  ],
}));

import { templateCatalogUrl } from "../lib/template-artifact-source";
import { searchTemplates } from "../tools/list-templates";

beforeEach(() => {
  delete process.env.EXTENSION_DEV_API_URL;
  delete process.env.EXTENSION_DEV_CONSOLE_URL;
});

describe("templateCatalogUrl", () => {
  it("emits the templates.extension.dev detail URL with the mcp utm contract", () => {
    expect(templateCatalogUrl("react")).toBe(
      "https://templates.extension.dev/react?utm_source=mcp&utm_medium=tool",
    );
  });

  it("carries utm_source=mcp-create for the create tool", () => {
    expect(templateCatalogUrl("typescript", "mcp-create")).toBe(
      "https://templates.extension.dev/typescript?utm_source=mcp-create&utm_medium=tool",
    );
  });

  it("escapes the slug so it cannot rewrite the URL", () => {
    expect(templateCatalogUrl("a/b?c")).toBe(
      "https://templates.extension.dev/a%2Fb%3Fc?utm_source=mcp&utm_medium=tool",
    );
  });
});

describe("extension_templates list emission", () => {
  it("adds catalogUrl beside repositoryUrl and downloads without replacing them", async () => {
    const frame = JSON.parse(await searchTemplates({}));
    expect(frame.ok).toBe(true);
    const t = frame.value.templates[0];
    expect(t.repositoryUrl).toContain("github.com/extension-js/examples");
    expect(t.downloads).toEqual({
      chrome: "https://example.com/content-react-chrome.zip",
    });
    expect(t.catalogUrl).toBe(
      "https://templates.extension.dev/content-react?utm_source=mcp&utm_medium=tool",
    );
  });
});
