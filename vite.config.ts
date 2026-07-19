import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          katex: ["katex"],
          marked: ["marked"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
