import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/generate.ts", "src/server/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  splitting: false,
  clean: true,
  outDir: "dist",
});
