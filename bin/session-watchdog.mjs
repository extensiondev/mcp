// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const recordPath = process.argv[2];

if (!recordPath) process.exit(2);

function readRecord() {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8"));

    return parsed && typeof parsed === "object" && Number.isInteger(parsed.pid) ? parsed : null;
  } catch {
    return null;
  }
}

function lastCallMs() {
  try {
    return fs.statSync(recordPath).mtimeMs;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function signal(pid, name) {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
    }

    return;
  }

  try {
    process.kill(-pid, name);
  } catch {
    try {
      process.kill(pid, name);
    } catch {
    }
  }
}

function contractPids(record) {
  try {
    const contract = JSON.parse(fs.readFileSync(record.contractPath, "utf8"));

    return [contract.browserPid, contract.launcherPid].filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function removeOwnRecords(record) {
  try {
    const marker = JSON.parse(fs.readFileSync(record.markerPath, "utf8"));
    if (marker && marker.pid === record.pid) fs.rmSync(record.markerPath, { force: true });
  } catch {
  }

  try {
    fs.rmSync(recordPath, { force: true });
  } catch {
  }
}

async function endSession(record, lastCallAtMs) {
  const pids = [record.pid, ...contractPids(record)].filter((pid, index, all) => all.indexOf(pid) === index);

  signal(record.pid, "SIGTERM");
  await sleep(record.graceMs);

  for (const pid of pids) {
    if (alive(pid)) signal(pid, "SIGKILL");
  }

  await sleep(250);

  const idledOut = {
    pid: record.pid,
    session: record.session,
    idleMinutes: record.idleMinutes,
    armedAt: record.armedAt,
    lastCallAt: new Date(lastCallAtMs).toISOString(),
    idledOutAt: new Date().toISOString(),
    processes: pids.map((pid) => ({ pid, gone: !alive(pid) })),
  };

  try {
    fs.writeFileSync(record.idledOutPath, JSON.stringify(idledOut));
  } catch {
  }

  removeOwnRecords(record);
}

const first = readRecord();

if (!first) process.exit(0);

const ownPid = first.pid;

for (;;) {
  const record = readRecord();

  if (!record || record.pid !== ownPid) process.exit(0);

  if (!alive(ownPid)) {
    removeOwnRecords(record);
    process.exit(0);
  }

  const last = lastCallMs();

  if (last !== null && Date.now() - last >= record.idleMs) {
    await endSession(record, last);
    process.exit(0);
  }

  await sleep(record.pollMs);
}
