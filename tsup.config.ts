import { copyFile, mkdir } from "node:fs/promises";
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
  // Kopíruj JSON datové soubory které kód za běhu čte (preseed list).
  async onSuccess() {
    await mkdir("dist/seed", { recursive: true });
    await copyFile("src/seed/top-cz-companies.json", "dist/seed/top-cz-companies.json");
  },
});
