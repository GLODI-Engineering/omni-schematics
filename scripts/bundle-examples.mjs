#!/usr/bin/env node
/**
 * Copy the example schematics into the extension so they ship in the .vsix.
 *
 * `examples/` lives at the repository root; `vsce package` only sees
 * `apps/vscode-extension/`. So the examples are copied in beside the webview
 * bundle, the same arrangement and for the same reason.
 *
 * Why they ship at all: a fresh install had nothing to open. `unzip -l` on the
 * 0.6.0 artifact matched no `.gsim_sch` whatsoever, so the first thing a new
 * user could do with the editor was draw a circuit from nothing.
 *
 * Only the documents are copied, not the `build_*.py` generators -- those need
 * the engine bindings and a checkout, and are for maintaining the examples
 * rather than for using them.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const FROM = join(REPO_ROOT, "examples");
const TO = join(REPO_ROOT, "apps", "vscode-extension", "media", "examples");

const documents = readdirSync(FROM).filter((name) => name.endsWith(".gsim_sch"));

if (documents.length === 0) {
  console.error("bundle-examples: no .gsim_sch files in examples/ — nothing to ship");
  process.exit(1);
}

// Cleared rather than merged: an example removed upstream must not linger in
// the package, where the Open Example list would still offer it.
rmSync(TO, { recursive: true, force: true });
mkdirSync(TO, { recursive: true });

for (const name of documents) {
  copyFileSync(join(FROM, name), join(TO, name));
}

console.log(`bundle-examples: copied ${documents.length} example(s) into media/examples`);
for (const name of documents) {
  console.log(`  ${name}`);
}
