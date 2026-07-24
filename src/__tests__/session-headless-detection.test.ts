import { describe, it, expect, afterEach } from "vitest";
import { sessionIsHeadless } from "../tools/open";

// open.ts skips the popup/sidebar auto-tab fallback for headed sessions. The
// detection used to key only off EXTENSION_HEADLESS, which is inert on
// extension@latest (4.0.15); the version-independent lever is
// EXTENSION_BROWSER_FLAGS=--headless=new, which the project settings.json ships.
// If detection misses that, a headless session is treated as headed and the
// caller gets the raw "no active browser window" error the fallback prevents.
describe("sessionIsHeadless", () => {
  const saved = {
    h: process.env.EXTENSION_HEADLESS,
    f: process.env.EXTENSION_BROWSER_FLAGS,
  };
  afterEach(() => {
    process.env.EXTENSION_HEADLESS = saved.h;
    process.env.EXTENSION_BROWSER_FLAGS = saved.f;
    if (saved.h === undefined) delete process.env.EXTENSION_HEADLESS;
    if (saved.f === undefined) delete process.env.EXTENSION_BROWSER_FLAGS;
  });

  function set(h?: string, f?: string) {
    if (h === undefined) delete process.env.EXTENSION_HEADLESS;
    else process.env.EXTENSION_HEADLESS = h;
    if (f === undefined) delete process.env.EXTENSION_BROWSER_FLAGS;
    else process.env.EXTENSION_BROWSER_FLAGS = f;
  }

  it("is false with neither lever set", () => {
    set(undefined, undefined);
    expect(sessionIsHeadless()).toBe(false);
  });

  it("honors EXTENSION_HEADLESS=1 / true", () => {
    set("1", undefined);
    expect(sessionIsHeadless()).toBe(true);
    set("true", undefined);
    expect(sessionIsHeadless()).toBe(true);
  });

  it("treats EXTENSION_HEADLESS=0 as headed", () => {
    set("0", undefined);
    expect(sessionIsHeadless()).toBe(false);
  });

  it("detects headless from EXTENSION_BROWSER_FLAGS in every form", () => {
    for (const flags of ["--headless=new", "--headless", "-headless", "--foo --headless=new --bar"]) {
      set(undefined, flags);
      expect(sessionIsHeadless(), flags).toBe(true);
    }
  });

  it("does not false-positive on unrelated flags", () => {
    set(undefined, "--window-size=1280,800 --disable-gpu");
    expect(sessionIsHeadless()).toBe(false);
    // A substring like "headlessish" in some other flag must not trip it.
    set(undefined, "--user-agent=headlessishBot");
    expect(sessionIsHeadless()).toBe(false);
  });

  it("stays headless when the flags force it even if EXTENSION_HEADLESS=0", () => {
    set("0", "--headless=new");
    expect(sessionIsHeadless()).toBe(true);
  });
});
