#!/usr/bin/env node
/**
 * Type-checks every TypeScript code block in docs/recipes/*.md against the
 * local dist types (dist/esm/index.d.ts). Run via:
 *
 *   pnpm docs:check-examples
 *
 * Algorithm:
 *   1. Scan docs/recipes/*.md for ```typescript ... ``` blocks.
 *   2. Write each block to a temp .ts file in .docs-check/ (project root).
 *   3. Generate a temp tsconfig that maps "ojin-client" → dist/esm/index.d.ts.
 *   4. Run `tsc --noEmit --project .docs-check-tsconfig.json`.
 *   5. Clean up and exit with the tsc exit code.
 *
 * Code blocks that are intentionally non-checked should use a fence other than
 * ```typescript (e.g. ```ts-ignore or plain ```text).
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const recipesDir = join(__dirname, "recipes");
const checkDir = join(rootDir, ".docs-check");
const tsconfigPath = join(rootDir, ".docs-check-tsconfig.json");

/** @param {string} markdown */
function extractTsBlocks(markdown) {
  const blocks = [];
  // Match ```typescript\n...\n``` — strict opening fence only
  const regex = /^```typescript\n([\s\S]*?)^```/gm;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    blocks.push(match[1].trimEnd());
  }
  return blocks;
}

// Clean up any leftover artefacts from a previous interrupted run.
rmSync(checkDir, { recursive: true, force: true });
rmSync(tsconfigPath, { force: true });

// Collect all recipe files.
let recipeFiles;
try {
  recipeFiles = readdirSync(recipesDir).filter((f) => f.endsWith(".md"));
} catch {
  console.error(`docs/recipes/ directory not found (expected at ${recipesDir})`);
  process.exit(1);
}

// Extract and write code blocks to temp files.
mkdirSync(checkDir, { recursive: true });
const tempFiles = [];

for (const file of recipeFiles) {
  const content = readFileSync(join(recipesDir, file), "utf-8");
  const blocks = extractTsBlocks(content);
  for (let i = 0; i < blocks.length; i++) {
    const name = `${file.replace(/\.md$/, "")}-${i}.ts`;
    writeFileSync(join(checkDir, name), blocks[i] + "\n");
    tempFiles.push(`.docs-check/${name}`);
  }
}

if (tempFiles.length === 0) {
  console.error("No ```typescript code blocks found in docs/recipes/*.md");
  rmSync(checkDir, { recursive: true, force: true });
  process.exit(1);
}

console.log(`Checking ${tempFiles.length} code block(s) from ${recipeFiles.length} recipe file(s)…`);

// Write a temp tsconfig that maps "ojin-client" to the local dist types.
// baseUrl "." is relative to this tsconfig's location (project root), so the
// path value "dist/esm/index.d.ts" resolves correctly.
const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "bundler",
    strict: true,
    noEmit: true,
    baseUrl: ".",
    paths: { "ojin-client": ["dist/esm/index.d.ts"] },
    lib: ["ES2022"],
  },
  files: tempFiles,
};
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

// Run tsc and capture the exit code.
let exitCode = 0;
try {
  execSync(`node_modules/.bin/tsc --project .docs-check-tsconfig.json`, {
    cwd: rootDir,
    stdio: "inherit",
  });
  console.log(`✓ All ${tempFiles.length} doc example(s) type-check successfully.`);
} catch {
  exitCode = 1;
} finally {
  rmSync(checkDir, { recursive: true, force: true });
  rmSync(tsconfigPath, { force: true });
}

process.exit(exitCode);
