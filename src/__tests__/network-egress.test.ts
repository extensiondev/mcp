import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROD_ORIGINS } from "@extension.dev/urls/origins";
import { describe, expect, it } from "vitest";

import { tools } from "../index";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

interface HostRow {
  host: string;
  reachedBy: string;
  sends: string;
  login: string;
  optOut: string;
  via?: { package: string; runs?: string };
}

const network = JSON.parse(read("docs/network.json")) as { hosts: HostRow[]; notReached: string[] };
const LOOPBACK = /^(localhost|127\.0\.0\.1|.*\.localhost|.*\.invalid|(.*\.)?example\.com)$/;

function hostsNamedInSource(): Set<string> {
  const files = execFileSync("git", ["ls-files", "--", "src", "bin", "module.ts"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(ts|js|mjs)$/.test(file) && !file.includes("__tests__"));
  const hosts = new Set<string>();

  for (const file of files) {
    for (const match of read(file).matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) hosts.add(match[1].toLowerCase());
  }

  for (const origin of Object.values(PROD_ORIGINS)) hosts.add(new URL(origin).hostname);

  return new Set([...hosts].filter((host) => !LOOPBACK.test(host)));
}

describe("docs/network.json, the one list of what leaves the machine (ledger 1145)", () => {
  it("names every host the source can reach, as reached or as a link only, and holds no host the code no longer names", () => {
    const named = hostsNamedInSource();
    const reached = network.hosts.map((row) => row.host);
    const known = new Set([...reached, ...network.notReached]);

    expect(new Set(reached).size).toBe(reached.length);
    expect(reached.filter((host) => network.notReached.includes(host))).toEqual([]);
    expect([...named].filter((host) => !known.has(host)).sort(), "named in src but not in docs/network.json").toEqual([]);
    expect(network.notReached.filter((host) => !named.has(host)), "notReached names a host src no longer names").toEqual([]);

    for (const row of network.hosts) {
      if (row.via) {
        const dist = path.join(root, "node_modules", row.via.package, "dist");
        const text = fs.readdirSync(dist, { recursive: true, encoding: "utf8" })
          .filter((file) => /\.(c|m)?js$/.test(file))
          .map((file) => fs.readFileSync(path.join(dist, file), "utf8"))
          .join("\n");

        expect(text, `${row.host} via ${row.via.package}`).toContain(row.via.runs ?? row.host);
      } else {
        expect(named.has(row.host), `${row.host} is not named in src; give it a via`).toBe(true);
      }
    }
  });

  it("says for every host which tools reach it, what they send, which login rides along and how to turn it off", () => {
    const registered = new Set(tools.map((tool) => tool.schema.name));

    for (const row of network.hosts) {
      for (const field of ["reachedBy", "sends", "login", "optOut"] as const) expect(row[field].trim().length, `${row.host} ${field}`).toBeGreaterThan(0);
      for (const [name] of row.reachedBy.matchAll(/\bextension_[a-z_]+/g)) expect(registered.has(name), `${row.host} names ${name}`).toBe(true);
    }

    expect(network.hosts.find((row) => row.host === "www.extension.dev")?.sends).toMatch(/query text/);
    expect(read("README.md")).toContain("docs/network.json");
  });
});
