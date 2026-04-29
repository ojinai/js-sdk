#!/usr/bin/env node
/**
 * Type-checks every TypeScript code block in README.md and docs/recipes/*.md
 * against the local dist types (dist/esm/index.d.ts). Run via:
 *
 *   pnpm docs:check-examples
 *
 * Algorithm:
 *   1. Scan README.md and docs/recipes/*.md for ```ts / ```typescript blocks.
 *   2. Write each block to a temp .ts file in .docs-check/ (project root).
 *   3. Generate a temp tsconfig that maps both package names to dist types.
 *   4. Run `tsc --noEmit --project .docs-check-tsconfig.json`.
 *   5. Clean up and exit with the tsc exit code.
 *
 * Code blocks that are intentionally non-checked should use a fence other than
 * ```typescript (e.g. ```ts-ignore or plain ```text).
 */

import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
  // Match ```ts\n...\n``` and ```typescript\n...\n``` blocks.
  const regex = /^```(?:ts|typescript)\n([\s\S]*?)^```/gm;
  for (let match = regex.exec(markdown); match !== null; match = regex.exec(markdown)) {
    blocks.push(match[1].trimEnd());
  }
  return blocks;
}

/**
 * README contains illustrative API snippets outside the runnable quickstart.
 * Keep the checker focused on the quickstart section there; recipe docs still
 * validate every TypeScript fence.
 *
 * @param {string} relativePath
 * @param {string} markdown
 */
function extractCheckableBlocks(relativePath, markdown) {
  const sourceMarkdown =
    relativePath === "README.md"
      ? (markdown.match(/^## Quick Start\n([\s\S]*?)^## Concepts$/m)?.[1] ?? markdown)
      : markdown;

  return extractTsBlocks(sourceMarkdown).filter((block) => block.includes("import "));
}

// Clean up any leftover artefacts from a previous interrupted run.
rmSync(checkDir, { recursive: true, force: true });
rmSync(tsconfigPath, { force: true });

// Collect all markdown files whose code examples should stay release-safe.
let recipeFiles;
try {
  recipeFiles = readdirSync(recipesDir).filter((f) => f.endsWith(".md"));
} catch {
  console.error(`docs/recipes/ directory not found (expected at ${recipesDir})`);
  process.exit(1);
}
const sourceFiles = [
  join(rootDir, "README.md"),
  ...recipeFiles.map((file) => join(recipesDir, file)),
];

// Extract and write code blocks to temp files.
mkdirSync(checkDir, { recursive: true });
const tempFiles = [];
const markdownFilesWithBlocks = new Set();

for (const sourceFile of sourceFiles) {
  const content = readFileSync(sourceFile, "utf-8");
  const relativePath = relative(rootDir, sourceFile);
  const blocks = extractCheckableBlocks(relativePath, content);
  for (let i = 0; i < blocks.length; i++) {
    const name = `${relativePath.replace(/[/.]/g, "-")}-${i}.ts`;
    writeFileSync(join(checkDir, name), `${blocks[i]}\n`);
    tempFiles.push(`.docs-check/${name}`);
    markdownFilesWithBlocks.add(relativePath);
  }
}

if (tempFiles.length === 0) {
  console.error("No ```ts or ```typescript code blocks found in README.md or docs/recipes/*.md");
  rmSync(checkDir, { recursive: true, force: true });
  process.exit(1);
}

console.log(
  `Checking ${tempFiles.length} code block(s) from ${markdownFilesWithBlocks.size} markdown file(s)...`,
);

// Write a temp tsconfig that maps both package names to the local dist types.
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
    paths: {
      "ojin-client": ["dist/esm/index.d.ts"],
      "@ojinai/js-sdk": ["dist/esm/index.d.ts"],
    },
    lib: ["ES2022"],
    types: ["node"],
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
