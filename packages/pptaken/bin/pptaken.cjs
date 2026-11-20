#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Entry point of `npx pptaken`. Deliberately tiny, CommonJS and old-fashioned JavaScript (var, function, no
// `import` syntax): it must parse on any Node.js version so that people with an old one get a readable message
// instead of a syntax error from the real program, which is ESM and needs Node.js 22.
"use strict";

var MIN_NODE_MAJOR = 22;
var EXIT_NODE_TOO_OLD = 5;

/** Returns null when `version` (e.g. "22.18.0") is supported, otherwise the message to print. */
function checkNodeVersion(version) {
  var major = parseInt(String(version).replace(/^v/, "").split(".")[0], 10);
  if (major >= MIN_NODE_MAJOR) return null;
  return (
    "PPTaken needs Node.js " +
    MIN_NODE_MAJOR +
    " or newer, but this is Node.js " +
    String(version).replace(/^v/, "") +
    ".\n" +
    "Install the current LTS version from https://nodejs.org/ and run the command again\n" +
    "(with nvm: nvm install " +
    MIN_NODE_MAJOR +
    "). Or run PPTaken with Docker: https://docs-pkn.arroz.dev/deploy/standalone/\n"
  );
}

/**
 * Checks the Node.js version, then loads the program. Returns the exit code when it stops here (old Node.js, or
 * `dryRun`), or null when the program was started. `options` exists for tests: { version, stderr, dryRun, argv }.
 */
function main(options) {
  var opts = options || {};
  var stderr = opts.stderr || process.stderr;
  var problem = checkNodeVersion(opts.version || process.versions.node);
  if (problem !== null) {
    stderr.write(problem);
    return EXIT_NODE_TOO_OLD;
  }
  if (opts.dryRun) return 0;
  var path = require("path");
  var url = require("url");
  var entry = url.pathToFileURL(path.join(__dirname, "..", "dist", "app", "cli.js")).href;
  // `import()` hidden in a Function body so this file still parses where dynamic import is a syntax error.
  var load = new Function("specifier", "return import(specifier)");
  load(entry).then(
    function (cli) {
      return cli.run(opts.argv || process.argv.slice(2));
    },
    function (error) {
      stderr.write(
        "PPTaken could not load its program files (" +
          (error && error.message ? error.message : String(error)) +
          ").\nReinstall it, for example: npx pptaken@latest\n",
      );
      process.exit(1);
    },
  );
  return null;
}

module.exports = {
  MIN_NODE_MAJOR: MIN_NODE_MAJOR,
  EXIT_NODE_TOO_OLD: EXIT_NODE_TOO_OLD,
  checkNodeVersion: checkNodeVersion,
  main: main,
};

if (require.main === module) {
  var code = main();
  if (code !== null) process.exit(code);
}
