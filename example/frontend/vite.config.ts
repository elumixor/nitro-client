import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      // Proxy all API and WS requests to Nitro backend
      "^/(simple-get|post-with-body|sse-streaming|sse-background-job|websocket\\.ws)": {
        target: "http://localhost:3456",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
