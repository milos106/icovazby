import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: false,
  minify: false,
  splitting: false,
  shims: false,
  dts: false,
});
