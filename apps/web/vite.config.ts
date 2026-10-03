import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// root 指向前端源码目录;构建产物出 apps/web/dist,由 src/server.ts 静态托管
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
