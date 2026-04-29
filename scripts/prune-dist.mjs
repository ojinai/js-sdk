import { rmSync } from "node:fs";

for (const path of [
  "dist/cjs/src",
  "dist/cjs/tests",
  "dist/esm/src",
  "dist/esm/tests",
  "dist/src",
  "dist/tests",
  "dist/types/src",
  "dist/types/tests",
]) {
  rmSync(path, { force: true, recursive: true });
}
