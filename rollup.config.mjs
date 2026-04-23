import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const sharedPlugins = [resolve(), commonjs()];

/**
 * All public subpath entry points.
 *
 * - src/index.ts          → "."              (default entry)
 * - src/protocol/index.ts → "./protocol"     (serialisation helpers + wire enums)
 *
 * src/utils/profiling.ts and src/utils/uuid.ts are reachable from src/index.ts
 * and therefore appear in the preserveModules output automatically; they do not
 * need to be listed here as explicit inputs.
 */
const inputs = ["src/index.ts", "src/protocol/index.ts"];

/** Shared TypeScript plugin options applied to every build. */
const sharedTsOptions = {
  tsconfig: "./tsconfig.json",
  // Strip the "src/" prefix from declaration output paths so that, e.g.,
  // src/utils/profiling.ts → dist/esm/utils/profiling.d.ts (not dist/esm/src/…).
  rootDir: "src",
};

export default [
  // ESM build (Node) — also emits .d.ts for all subpaths
  {
    input: inputs,
    output: {
      dir: "dist/esm",
      format: "esm",
      sourcemap: true,
      preserveModules: true,
      preserveModulesRoot: "src",
    },
    plugins: [
      ...sharedPlugins,
      typescript({
        ...sharedTsOptions,
        declaration: true,
        declarationDir: "dist/esm",
        outDir: "dist/esm",
      }),
    ],
    external: ["ws"],
  },
  // CJS build (Node)
  {
    input: inputs,
    output: {
      dir: "dist/cjs",
      format: "cjs",
      sourcemap: true,
      preserveModules: true,
      preserveModulesRoot: "src",
    },
    plugins: [
      ...sharedPlugins,
      typescript({
        ...sharedTsOptions,
        // declarationDir must be inside the rollup `dir`; tsconfig default of
        // "dist/types" would fail validation.  ESM build owns the canonical
        // .d.ts files referenced by package.json `types`; CJS declarations are
        // generated here as a convenience for CJS-only toolchains.
        declaration: true,
        declarationDir: "dist/cjs",
        outDir: "dist/cjs",
      }),
    ],
    external: ["ws"],
  },
];
