// SPDX-License-Identifier: AGPL-3.0-or-later
// npm-shrinkwrap.json for the published package, generated from the workspace's pnpm lockfile (no network).
//
// npm honours a published npm-shrinkwrap.json when the package is installed as a dependency or by npx: the
// runtime dependency tree (better-sqlite3 and node-addon-api today) is then installed at the exact versions this
// repository tested, verified against their SHA-512 integrity. Without it, `node-addon-api@^8` would float to
// whatever is newest on the day a user runs `npx pptaken`.

/** Strips the quotes pnpm puts around keys such as '@scope/name@1.0.0'. */
const unquote = (s) => s.replace(/^'(.*)'$/, "$1");

/** `name@version(peer@x)` -> { name, version } (the name may be scoped). */
export function splitKey(key) {
  const clean = unquote(key).replace(/\(.*$/, "");
  const at = clean.lastIndexOf("@");
  if (at <= 0) throw new Error(`unexpected lockfile key ${key}`);
  return { name: clean.slice(0, at), version: clean.slice(at + 1) };
}

/** Top-level blocks of one section of a pnpm v9 lockfile: key -> its indented lines. */
function blocks(text, section) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(`${section}:`);
  if (start === -1) throw new Error(`pnpm-lock.yaml has no "${section}:" section`);
  const out = new Map();
  let key = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level section
    const top = /^ {2}(\S.*?):(?: \{\})?\s*$/.exec(line);
    if (top) {
      key = unquote(top[1]);
      out.set(key, []);
      continue;
    }
    if (key !== null && line.startsWith("    ")) out.get(key).push(line);
  }
  return out;
}

/**
 * Builds the shrinkwrap object for `root.dependencies` from a pnpm v9 lockfile. Refuses anything it cannot pin
 * exactly: a missing integrity, optional or platform-specific dependencies, or two versions of one package.
 */
export function shrinkwrapFromPnpmLock(lockText, root) {
  if (!/^lockfileVersion: '9\.\d+'/m.test(lockText)) throw new Error("expected a pnpm v9 lockfile");
  const packages = blocks(lockText, "packages");
  const snapshots = blocks(lockText, "snapshots");
  const entries = {};
  const queue = Object.entries(root.dependencies).map(([name, version]) => ({ name, version }));
  while (queue.length > 0) {
    const { name, version } = queue.shift();
    const path = `node_modules/${name}`;
    if (entries[path] !== undefined) {
      if (entries[path].version !== version) {
        throw new Error(
          `two versions of ${name} (${entries[path].version}, ${version}) need a nested layout`,
        );
      }
      continue;
    }
    const key = `${name}@${version}`;
    const pkg = packages.get(key);
    if (pkg === undefined) throw new Error(`${key} is not in pnpm-lock.yaml`);
    const integrity = /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(pkg.join("\n"))?.[1];
    if (integrity === undefined)
      throw new Error(`${key} has no sha512 integrity in pnpm-lock.yaml`);
    if (pkg.some((l) => /^\s+(os|cpu|libc):/.test(l)))
      throw new Error(`${key} is platform-specific`);
    const snap = snapshots.get(key) ?? [];
    if (snap.some((l) => /^\s+(optionalDependencies|peerDependencies):/.test(l))) {
      throw new Error(`${key} has optional or peer dependencies; extend shrinkwrap.mjs first`);
    }
    const deps = {};
    let inDeps = false;
    for (const line of snap) {
      if (/^ {4}dependencies:\s*$/.test(line)) {
        inDeps = true;
        continue;
      }
      if (/^ {4}\S/.test(line)) inDeps = false;
      const dep = inDeps ? /^ {6}(\S+): (\S+)\s*$/.exec(line) : null;
      if (dep) deps[unquote(dep[1])] = splitKey(`x@${unquote(dep[2])}`).version;
    }
    const base = name.startsWith("@") ? name.split("/")[1] : name;
    entries[path] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`,
      integrity,
      ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}),
    };
    for (const [depName, depVersion] of Object.entries(deps)) {
      queue.push({ name: depName, version: depVersion });
    }
  }
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  return {
    name: root.name,
    version: root.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: root.name,
        version: root.version,
        license: root.license,
        dependencies: root.dependencies,
        bin: root.bin,
        engines: root.engines,
      },
      ...sorted,
    },
  };
}
