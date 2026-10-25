#!/usr/bin/env node
// Builds a universal (Apple silicon + Intel) release of Claude Switch:
//
//   pnpm app:release <patch | minor | major | MAJOR.MINOR.PATCH> [extra tauri build arguments]
//   node scripts/release.mjs --resolve <patch | minor | major | MAJOR.MINOR.PATCH>
//
// `patch`, `minor` and `major` bump the version in package.json. The build
// sets the version in every manifest that carries one, packages the VS Code
// extension with it, then runs
// `tauri build --target universal-apple-darwin --config src-tauri/tauri.release.json`.
// `--resolve` only prints the version a build would use, and changes nothing.
// Signing and notarization use the APPLE_* variables from the environment
// (see docs/RELEASE.md).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "--") cliArgs.shift();
const resolveOnly = cliArgs[0] === "--resolve";
if (resolveOnly) cliArgs.shift();
const [requested, ...extraArgs] = cliArgs;

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// macOS bundle versions are numeric, so no pre-release suffixes.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The version to release: `spec` itself, or the current version bumped. */
function resolveVersion(/** @type {string | undefined} */ spec) {
  if (spec && SEMVER.test(spec)) return spec;
  if (spec !== "patch" && spec !== "minor" && spec !== "major") {
    fail(
      "give the version as patch, minor, major or MAJOR.MINOR.PATCH, for example: pnpm app:release minor",
    );
  }
  const manifest = readFileSync(join(root, "package.json"), "utf8");
  const current = /^\s*"version":\s*"([^"]+)"/m.exec(manifest)?.[1] ?? "";
  const parts = SEMVER.exec(current);
  if (!parts) fail(`package.json has version "${current}", which is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = parts.slice(1).map(Number);
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const version = resolveVersion(requested);
if (resolveOnly) {
  console.log(version);
  process.exit(0);
}

/**
 * Sets the version in a file: group 2 of `pattern`'s first match.
 * @param {string} file
 * @param {RegExp} pattern
 */
function setVersion(file, pattern) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const match = pattern.exec(text);
  if (!match) fail(`could not find the version in ${file}`);
  if (match[2] !== version) writeFileSync(path, text.replace(pattern, `$1${version}$3`));
  console.log(`${file}: ${match[2]} → ${version}`);
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const installed = spawnSync("rustup", ["target", "list", "--installed"], {
  cwd: root,
  encoding: "utf8",
});
const missing = ["aarch64-apple-darwin", "x86_64-apple-darwin"].filter(
  (target) => !installed.stdout?.split("\n").includes(target),
);
if (installed.status !== 0 || missing.length > 0) {
  fail(
    `a universal build needs both Rust targets. Install them with:\n  rustup target add ${missing.join(" ") || "aarch64-apple-darwin x86_64-apple-darwin"}`,
  );
}

setVersion("package.json", /^(\s*"version":\s*")([^"]+)(")/m);
setVersion("vscode-extension/package.json", /^(\s*"version":\s*")([^"]+)(")/m);
setVersion("src-tauri/tauri.conf.json", /^(\s*"version":\s*")([^"]+)(")/m);
setVersion("src-tauri/Cargo.toml", /^(version = ")([^"]+)(")/m);
setVersion("src-tauri/Cargo.lock", /(name = "claude-switch"\nversion = ")([^"]+)(")/);

run("pnpm", ["ext:package"]);
run("pnpm", [
  "tauri",
  "build",
  "--target",
  "universal-apple-darwin",
  "--config",
  "src-tauri/tauri.release.json",
  ...extraArgs,
]);

console.log(
  `\nBuilt Claude Switch ${version}:\n  src-tauri/target/universal-apple-darwin/release/bundle/dmg/Claude Switch_${version}_universal.dmg`,
);
