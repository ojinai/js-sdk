#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

step() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf 'integration:check failed: %s\n' "$1" >&2
  exit 1
}

run() {
  step "$1"
  shift
  "$@"
}

assert_no_matches() {
  local label="$1"
  shift

  step "$label"
  if "$@"; then
    fail "$label"
  fi
}

assert_contains() {
  local label="$1"
  local needle="$2"
  shift 2

  step "$label"
  local output
  if ! output="$("$@" 2>&1)"; then
    printf '%s\n' "$output"
    fail "$label"
  fi

  printf '%s\n' "$output"
  [[ "$output" == *"$needle"* ]] || fail "$label (missing '$needle')"
}

assert_file() {
  local label="$1"
  local path="$2"
  step "$label"
  [[ -f "$path" ]] || fail "$label ($path)"
}

assert_glob() {
  local label="$1"
  local pattern="$2"
  step "$label"
  shopt -s nullglob
  local matches=($pattern)
  shopt -u nullglob
  (( ${#matches[@]} > 0 )) || fail "$label ($pattern)"
}

assert_count_ge() {
  local label="$1"
  local minimum="$2"
  local count="$3"
  step "$label"
  printf '%s\n' "$count"
  (( count >= minimum )) || fail "$label (expected >= $minimum)"
}

step "Clean checkout required"
[[ -z "$(git status --short)" ]] || fail "run integration:check from a clean checkout"

run "Install dependencies" pnpm install --frozen-lockfile
run "Lint (read-only gate)" pnpm lint:check
run "Typecheck" pnpm typecheck
run "Unit/integration tests" pnpm test
run "Coverage gate" pnpm test:cov
run "Build dist outputs" pnpm build
run "Wire compatibility fixtures" pnpm test:wire-compat
run "Generate docs" pnpm run docs
run "Type-check README and recipe examples" pnpm docs:check-examples

assert_no_matches \
  "No raw console.* outside the logger adapter" \
  rg -n "console\." src/ --glob '!src/utils/logger.ts'

assert_no_matches \
  "No unowned setTimeout/setInterval in src/" \
  rg -n "(setTimeout|setInterval)\(" src/ \
    --glob '!src/utils/sleep.ts' \
    --glob '!src/ws-transport-node.ts'

assert_no_matches \
  "No browser globals in src/" \
  rg -n "\b(window|document|navigator)\b" src/

assert_no_matches \
  "No generic Uint8Array syntax in protocol types" \
  rg -n "Uint8Array<" src/protocol/

assert_no_matches \
  "README does not mention removed polling APIs" \
  rg -n "receiveMessage|startInteraction" README.md

run "Package metadata assertions" node <<'NODE'
const { readFileSync } = require("node:fs");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

if ("browser" in pkg) {
  console.error("package.json must not define a browser field");
  process.exit(1);
}

if (!String(pkg.version).includes("1.0.0-rc")) {
  console.error(`package.json version must contain 1.0.0-rc, got ${pkg.version}`);
  process.exit(1);
}

if (pkg.engines?.node !== ">=20") {
  console.error(`package.json engines.node must be >=20, got ${pkg.engines?.node}`);
  process.exit(1);
}

const requiredExports = [".", "./protocol", "./profiling", "./internal/uuid"];
for (const key of requiredExports) {
  if (!(key in (pkg.exports ?? {}))) {
    console.error(`Missing package export: ${key}`);
    process.exit(1);
  }
}
NODE

run "Rollup stays Node-only" node <<'NODE'
const { readFileSync } = require("node:fs");
const rollupConfig = readFileSync("rollup.config.mjs", "utf8");

if (rollupConfig.includes("browser: true")) {
  console.error("rollup.config.mjs must not enable browser resolution");
  process.exit(1);
}
NODE

run "README states the SDK is server-side only" node <<'NODE'
const { readFileSync } = require("node:fs");
const readme = readFileSync("README.md", "utf8");
const requiredSnippets = [
  "Server-side only",
  "Not for client-side use",
];

for (const snippet of requiredSnippets) {
  if (!readme.includes(snippet)) {
    console.error(`README.md must contain: ${snippet}`);
    process.exit(1);
  }
}
NODE

assert_count_ge \
  "CHANGELOG keeps the main Keep a Changelog sections" \
  5 \
  "$(grep -Ec '^### Added|^### Changed|^### Removed|^### Fixed|^### Breaking changes' CHANGELOG.md)"

assert_count_ge \
  "CHANGELOG references the shipped D-number set" \
  17 \
  "$(grep -Ec 'D1|D2|D3|D4|D5|D6|D7|D8|D9|D11|D12|D13|D14|D15|D17|D18|D19' CHANGELOG.md)"

assert_file "SECURITY.md is present" "SECURITY.md"
assert_file "CONTRIBUTING.md is present" "CONTRIBUTING.md"
assert_file "CHANGELOG.md is present" "CHANGELOG.md"
assert_file "LICENSE is present" "LICENSE"
assert_file "typedoc.json is present" "typedoc.json"

step "Publish dry-run tarball assertions"
publish_output="$(pnpm run publish:dryrun 2>&1)" || {
  printf '%s\n' "$publish_output"
  fail "Publish dry-run"
}
printf '%s\n' "$publish_output"

for required in "README.md" "CHANGELOG.md" "SECURITY.md" "LICENSE" "package.json" "dist/esm/index.js" "dist/cjs/index.js"; do
  [[ "$publish_output" == *"$required"* ]] || fail "Publish dry-run missing $required"
done

for forbidden in "tests/" "scripts/" ".agents/" ".tickets/" "src/"; do
  [[ "$publish_output" == *"$forbidden"* ]] && fail "Publish dry-run unexpectedly includes $forbidden"
done

run "All dependency tickets are closed" node <<'NODE'
const { readFileSync } = require("node:fs");

const ticket = readFileSync(".tickets/ost-i1nt.md", "utf8");
const depsLine = ticket.split("\n").find((line) => line.startsWith("deps:"));

if (!depsLine) {
  console.error("Cannot locate deps: line in .tickets/ost-i1nt.md");
  process.exit(1);
}

const deps = [...new Set(depsLine.match(/ost-[a-z0-9]{4}/g) ?? [])];
const openDeps = deps.filter((id) => !/^status:\s*closed$/m.test(readFileSync(`.tickets/${id}.md`, "utf8")));

if (openDeps.length > 0) {
  console.error(`Open dependency tickets: ${openDeps.join(", ")}`);
  process.exit(1);
}
NODE

printf '\nIntegration gate passed.\n'
