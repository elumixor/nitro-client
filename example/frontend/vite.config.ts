import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      // Proxy all API and WS requests to Nitro backend
      "^/(hello|greet|countdown|process|chat\\.ws)": {
        target: "http://localhost:3456",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
