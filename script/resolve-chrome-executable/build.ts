import { build } from "bun";
import { chmodSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const result = await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

const distPath = join("./dist", "index.js");
const content = readFileSync(distPath, "utf8");
if (!content.startsWith("#!")) {
  writeFileSync(distPath, "#!/usr/bin/env node\n" + content);
}
chmodSync(distPath, 0o755);

console.log("Build complete: dist/index.js");
