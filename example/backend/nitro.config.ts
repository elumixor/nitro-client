import { resolve } from "node:path";

export default {
  srcDir: "src",
  experimental: {
    websocket: true,
  },
  alias: {
    "@elumixor/nitro-client/server": resolve(__dirname, "../../dist/server/index.mjs"),
  },
};
