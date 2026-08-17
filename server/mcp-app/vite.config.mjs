import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: ROOT,
  plugins: [viteSingleFile()],
  build: {
    outDir: join(ROOT, "dist"),
    emptyOutDir: true,
    rollupOptions: { input: join(ROOT, "index.html") },
  },
});
