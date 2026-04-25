import { rmSync } from "node:fs";

for (const path of ["dist/cjs/src", "dist/cjs/tests", "dist/esm/src", "dist/esm/tests"]) {
  rmSync(path, { force: true, recursive: true });
}
