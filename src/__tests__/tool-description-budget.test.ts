import { describe, expect, it } from "vitest";

import { tools } from "../index";
import { TOOL_POLICY, TOOL_TITLES, toolTitle } from "../lib/tool-policy";

/* @invariant A DESCRIPTION ONLY GETS SHORTER. The reference study of
 * 2026-10-20 found 29 tools carrying 47,938 characters of description, with
 * extension_submit at 8,120 in 27 sentences, the manual the model reads on
 * every call and still misses the one line that matters. The ceilings below
 * are each tool's length at the time it was last cut, rounded up; a change
 * that grows a description past its ceiling fails here, and a cut lowers the
 * ceiling in the same commit. The target shape is four parts: the verb, what
 * it records and which links it makes, what it is not for and the sibling to
 * use, and the one default that surprises; detail belongs in the input
 * descriptions and workflow in the server instructions. Ledger 1106 reset
 * the ceilings once, on 2026-11-24, when every description gained what it
 * answers and which neighbor answers the rest, under a 400-character cap
 * for the default list; from there they only get shorter again.
 */
const CEILINGS: Record<string, number> = {
  extension_add_feature: 380,
  extension_analyze: 330,
  extension_approvals: 250,
  extension_assert: 350,
  extension_auth: 400,
  extension_browsers: 280,
  extension_build: 340,
  extension_builds: 330,
  extension_builds_act: 370,
  extension_create: 360,
  extension_dev: 370,
  extension_docs_search: 280,
  extension_doctor: 290,
  extension_dom_snapshot: 340,
  extension_element: 350,
  extension_eval: 400,
  extension_inspect: 400,
  extension_list_extensions: 210,
  extension_logs: 390,
  extension_manifest_validate: 290,
  extension_network: 260,
  extension_open: 400,
  extension_preview_web: 370,
  extension_project_create: 480,
  extension_publish: 400,
  extension_release_promote: 400,
  extension_release_status: 290,
  extension_reload: 300,
  extension_screenshot: 240,
  extension_shares: 310,
  extension_start: 370,
  extension_stop: 310,
  extension_storage: 320,
  extension_submit: 500,
  extension_submit_check: 390,
  extension_templates: 370,
  extension_theme_verify: 280,
  extension_try: 280,
  extension_wait: 380,
  extension_workspace: 370,
  extension_workspace_create: 240,
};

const TARGET = 400;

describe("tool descriptions only get shorter", () => {
  it("stays under each tool's ceiling, and the ceiling table names every tool", () => {
    const names = tools.map((tool) => tool.schema.name).sort();

    expect(Object.keys(CEILINGS).sort()).toEqual(names);

    for (const tool of tools) {
      const length = tool.schema.description.replace(/\s+/g, " ").trim().length;

      expect(length, `${tool.schema.name} is ${length} characters; its ceiling is ${CEILINGS[tool.schema.name]}`).toBeLessThanOrEqual(CEILINGS[tool.schema.name]!);
    }
  });

  it("names the tools still above the target, so the cut has a list to work from", () => {
    const over = tools
      .filter((tool) => tool.schema.description.replace(/\s+/g, " ").trim().length > TARGET)
      .map((tool) => tool.schema.name)
      .sort();

    expect(over.length).toBeLessThanOrEqual(2);
  });
});

describe("every tool carries a title a consent prompt can show", () => {
  it("has a two-to-five-word title that starts with a capital verb, for every registered tool", () => {
    for (const name of Object.keys(TOOL_POLICY)) {
      const title = TOOL_TITLES[name];

      expect(title, name).toBeTruthy();
      expect(title!.split(" ").length, `${name}: ${title}`).toBeGreaterThanOrEqual(2);
      expect(title!.split(" ").length, `${name}: ${title}`).toBeLessThanOrEqual(5);
      expect(title, `${name}: ${title}`).toMatch(/^[A-Z][a-z]+ /);
    }

    expect(Object.keys(TOOL_TITLES).sort()).toEqual(Object.keys(TOOL_POLICY).sort());
    expect(toolTitle("extension_submit")).toBe("Submit to a store");
    expect(toolTitle("nope")).toBe("nope");
  });
});
