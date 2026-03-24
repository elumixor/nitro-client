# nitro-client

Generate a typed API client from Nitro route handlers.

## Installation

```bash
npm install -D @elumixor/nitro-client
```

If you use Bun, you can also run the CLI through `bunx` without a local install.

## Configuration

Create a `nitro.config.ts` file in the project root:

```ts
export default {
  src: "src",
  out: "generated/client",
  tsconfig: "tsconfig.json",
  excludeDirs: "",
  excludeRoutes: "",
};
```

The defaults are:

- `src`: `src`
- `out`: `generated/client`
- `tsconfig`: `tsconfig.json`

## Generate the client

```bash
bunx nitro-client
```

This scans `src/routes`, generates a client at `generated/client/index.ts`, and infers response types from your route handlers.

## Example

Example route files:

```ts
// src/routes/users.get.ts
export default defineEventHandler(() => {
  return [{ id: 1, name: "Ada" }];
});
```

```ts
// src/routes/users/[id].get.ts
export default defineEventHandler(() => {
  return { id: 1, name: "Ada" };
});
```

After generating the client, you can use it like this:

```ts
import { NitroAPI } from "./generated/client";

const api = new NitroAPI({
  baseUrl: "http://localhost:3000",
});

const users = await api.users.$get();
const user = await api.users("1").$get();
```

## Notes

- Route files must follow Nitro-style method suffixes such as `.get.ts`, `.post.ts`, `.patch.ts`, `.put.ts`, and `.delete.ts`.
- Dynamic route segments like `[id]` become callable path segments in the generated client.
