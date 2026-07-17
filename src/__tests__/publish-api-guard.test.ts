import { describe, it, expect } from "vitest";
import { safeApiBase } from "../lib/login-flow";

// SECURITY: the publish flow attaches a bearer access token to a request to this
// base URL. safeApiBase must refuse anything that could exfiltrate the token
// (non-https, arbitrary schemes) while still allowing the documented https
// override and localhost dev.
describe("safeApiBase (publish token egress guard)", () => {
  it("allows the default https platform URL", () => {
    const r = safeApiBase("https://www.extension.dev");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.base).toBe("https://www.extension.dev");
  });

  it("allows a self-hosted https URL and strips trailing slashes", () => {
    const r = safeApiBase("https://platform.example.com/");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.base).toBe("https://platform.example.com");
  });

  it("allows http only for localhost (dev)", () => {
    expect(safeApiBase("http://localhost:3000").ok).toBe(true);
    expect(safeApiBase("http://127.0.0.1:3000").ok).toBe(true);
  });

  it("refuses http to a non-localhost host (plaintext token egress)", () => {
    const r = safeApiBase("http://evil.example.com");
    expect(r.ok).toBe(false);
  });

  it("refuses non-http(s) schemes", () => {
    expect(safeApiBase("file:///etc/passwd").ok).toBe(false);
    expect(safeApiBase("ftp://example.com").ok).toBe(false);
  });

  it("refuses a malformed URL", () => {
    expect(safeApiBase("not a url").ok).toBe(false);
    expect(safeApiBase("").ok).toBe(false);
  });
});
