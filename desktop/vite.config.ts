import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: "127.0.0.1",
		// Browser-only development: scripts/dev-bridge.mjs stands in for the Rust process commands.
		proxy: { "/__bridge": { target: "http://127.0.0.1:1421", changeOrigin: false } },
	},
	envPrefix: ["VITE_", "TAURI_ENV_"],
	build: { target: "es2022", outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
