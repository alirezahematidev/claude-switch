#!/usr/bin/env node
// Builds Claude Switch's helper (src-tauri/helper) into vscode-extension/bin,
// where the extension starts it from.
//
//   node scripts/build-helper.mjs         release build for Apple silicon and Intel, as one binary
//   node scripts/build-helper.mjs --dev   debug build for this Mac only
//
// The release build needs both Rust targets:
//   rustup target add aarch64-apple-darwin x86_64-apple-darwin

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, "src-tauri", "Cargo.toml");
const target = join(root, "src-tauri", "target");
const out = join(root, "vscode-extension", "bin", "claude-switch-helper");
const name = "claude-switch-helper";

/**
 * @param {string} cmd
 * @param {string[]} args
 */
function run(cmd, args) {
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
}

/** @param {string[]} args */
function cargo(...args) {
  run("cargo", ["build", "--manifest-path", manifest, "-p", name, ...args]);
}

mkdirSync(dirname(out), { recursive: true });
if (process.argv.includes("--dev")) {
  cargo();
  copyFileSync(join(target, "debug", name), out);
} else {
  const arches = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  for (const arch of arches) cargo("--release", "--target", arch);
  run("lipo", [
    "-create",
    "-output",
    out,
    ...arches.map((arch) => join(target, arch, "release", name)),
  ]);
}
chmodSync(out, 0o755);
console.log(`Built ${out}`);
