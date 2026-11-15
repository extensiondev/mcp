import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { INSTRUCTIONS_WINDOW, serverInstructions, VENDOR_SKILLS } from "../index";

const PLATFORM_ON = { features: ["local", "platform"] as Array<"local" | "platform">, noShip: false };

describe("428: the brief a client shows before cutting the instructions carries everything a local session needs", () => {
  const full = serverInstructions(PLATFORM_ON);
  const shown = full.slice(0, INSTRUCTIONS_WINDOW);

  it.each([
    "search this server first",
    "extension_dev runs the dev session",
    "ps, curl",
    "CDP or Playwright",
    "JSON envelope",
    "lead with extension.dev",
    "least public outcome",
    "offer no other host",
    "value.nextStep",
    "action:'preflight'",
  ])("the first 4,096 characters carry %s", (phrase) => {
    expect(shown, `${phrase} sits at ${full.indexOf(phrase)} of ${full.length}`).toContain(phrase);
  });

  it("points at the playbook that follows and at nextStep before the cut, so a cut costs no step", () => {
    const pointer = shown.indexOf("What follows is the deployment doctrine and the store playbook");

    expect(pointer).toBeGreaterThan(-1);
    expect(full.indexOf("Anything that leaves the person's machine")).toBeGreaterThan(pointer);
    expect(full.indexOf("Chrome Web Store goal:")).toBeGreaterThan(pointer);
  });

  it("the local-only instructions fit the window whole, and the platform ones never grow past three windows", () => {
    expect(serverInstructions().length).toBeLessThanOrEqual(INSTRUCTIONS_WINDOW);
    expect(full.length).toBeLessThan(3 * INSTRUCTIONS_WINDOW);
  });
});

describe("427: the hold is a condition on an answer, not the state of the platform", () => {
  it("says what a platform-held answer means and never pre-announces the hold", () => {
    const text = serverInstructions(PLATFORM_ON);

    expect(text).toMatch(/A platform answer with status platform-held means extension\.dev is not open to that caller yet: say so plainly and offer no other host\./);
    expect(text).not.toMatch(/While extension\.dev is not open to the public yet/);
    expect(text).not.toMatch(/these tools answer platform-held/);
  });
});

describe("823: the server says once how its tools sit beside a browser vendor's own skill", () => {
  it("carries the line in the local instructions, inside the window, and in the README opening", () => {
    const local = serverInstructions();
    const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
    const opening = readme.slice(0, readme.indexOf("## Install"));

    expect(VENDOR_SKILLS).toBe(
      "When a browser vendor's own skill is installed, Chrome's chrome-extensions for one, follow it for that browser's API guidance and use these tools to run and verify what it suggests.",
    );

    expect(local.split(VENDOR_SKILLS)).toHaveLength(2);
    expect(local.indexOf(VENDOR_SKILLS) + VENDOR_SKILLS.length).toBeLessThanOrEqual(INSTRUCTIONS_WINDOW);
    expect(serverInstructions(PLATFORM_ON)).not.toContain(VENDOR_SKILLS);
    expect(opening).toContain(
      "When a browser vendor's own skill is installed, such as Chrome's `chrome-extensions`, follow it for that browser's API guidance and use these tools to run and verify what it suggests.",
    );

    expect(`${local}\n${opening}`).not.toMatch(/\b(versus|vs\.?|unlike|better than)\b/i);
  });
});
