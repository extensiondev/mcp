// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NEVER_PREFILLED } from "../lib/store-bring-list";
import { readinessRowsOf, supplierOf } from "../lib/store-onboarding-suppliers";

const EDGE_PRIVACY = ["edge.remote_code", "edge.data_usage"];
const EDGE_LISTING_TEXT = ["edge.single_purpose", "edge.permission_justifications"];

describe("the readiness list leaves every owner-certified declaration and every unknown row to the owner", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in this suite"))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(EDGE_PRIVACY)("tags the Edge Privacy page row %s as only you can decide, never drafted", (id) => {
    expect(supplierOf({ id, satisfiedBy: "store-dashboard" })).toBe("person-decides");
    expect(NEVER_PREFILLED.has(id)).toBe(true);
  });

  it.each(EDGE_LISTING_TEXT)("keeps the Edge listing text row %s draftable from STORE.md, like its Chrome twin", (id) => {
    expect(supplierOf({ id, satisfiedBy: "store-dashboard" })).toBe("agent-drafts");
    expect(supplierOf({ id: id.replace("edge.", "chrome."), satisfiedBy: "store-md: x" })).toBe("agent-drafts");
    expect(NEVER_PREFILLED.has(id)).toBe(false);
  });

  it("tags the App Store copyright as only you can decide and keeps the keywords draftable", () => {
    expect(supplierOf({ id: "safari.copyright", satisfiedBy: "store-dashboard" })).toBe("person-decides");
    expect(supplierOf({ id: "safari.keywords", satisfiedBy: "store-dashboard" })).toBe("agent-drafts");
  });

  it.each(["store-dashboard", "listing", "store-md: Notes", ""])("tags a row this server does not know as only you can decide when it is satisfied by %j", (satisfiedBy) => {
    expect(supplierOf({ id: "edge.some_future_requirement", satisfiedBy })).toBe("person-decides");
  });

  it("files the new rows under person decides in the grouped list", () => {
    const rows = [...EDGE_PRIVACY, "safari.copyright", "chrome.some_future_requirement"].map((id) => ({ id, required: true, status: "unknown", satisfiedBy: "store-dashboard" }));
    const { groups } = readinessRowsOf({ edge: { requirements: { items: rows } } }, ["edge"]);

    expect(groups["person-decides"].required).toEqual(rows.map((row) => row.id));
    expect(groups["agent-drafts"].required).toEqual([]);
  });
});
