import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  plugins: [react()],
  base: "/mcp-app-assets/",
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "src/ui/workspace-app.html"),
      output: {
        entryFileNames: "assets/workspace-app.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith(".css")
            ? "assets/workspace-app.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
