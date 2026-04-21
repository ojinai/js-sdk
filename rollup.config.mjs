import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const sharedPlugins = [
  resolve({ browser: true }),
  commonjs(),
];

export default [
  // ESM build
  {
    input: "src/index.ts",
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
        tsconfig: "./tsconfig.json",
        declaration: true,
        declarationDir: "dist/esm",
        outDir: "dist/esm",
      }),
    ],
    external: ["ws"],
  },
  // CJS build
  {
    input: "src/index.ts",
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
        tsconfig: "./tsconfig.json",
        declaration: true,
        declarationDir: "dist/cjs",
        outDir: "dist/cjs",
      }),
    ],
    external: ["ws"],
  },
];
