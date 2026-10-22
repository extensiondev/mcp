// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant A SERVER'S DEFAULT LOGIN IS THE ONE IT FIRST RESOLVED, NOT THE
 * NEWEST ON THE MACHINE. The login store is one file shared by every process
 * on the machine, and a login rewrites its `active` pointer to the newest
 * entry. A running server that read `active` on every call would act on
 * whatever project was signed in last anywhere on the machine: on 2026-10-22
 * a promote with no `project` reached rebeccat because another process had
 * signed in to rebeccat a minute earlier, while every call before it had
 * resolved leon. So the first unnamed resolve on a server records the key it
 * chose, per store file and per platform server, and every later unnamed
 * call uses that same entry while it is still stored. Only this process
 * moves it: a login or logout made through this server, or a rename the
 * platform answers. A call that names `project` never consults it.
 */
const kept = new Map<string, string>();

function slot(file: string, server: string): string {
  return `${file}\n${server}`;
}

export function keptLogin(file: string, server: string): string | null {
  return kept.get(slot(file, server)) ?? null;
}

export function keepLogin(file: string, server: string, key: string): void {
  kept.set(slot(file, server), key);
}

export function releaseLogin(file: string, key: string): void {
  for (const [name, value] of kept) {
    if (name.startsWith(`${file}\n`) && value === key) kept.delete(name);
  }
}

export function releaseStore(file: string): void {
  for (const name of kept.keys()) {
    if (name.startsWith(`${file}\n`)) kept.delete(name);
  }
}

export function moveKeptLogin(file: string, from: string, to: string): void {
  for (const [name, value] of kept) {
    if (name.startsWith(`${file}\n`) && value === from) kept.set(name, to);
  }
}
