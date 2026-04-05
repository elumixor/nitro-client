# nitro-client

Generate a fully typed API client from Nitro route handlers — with support for streaming, background jobs, request/response type inference, and more.

## Installation

```bash
npm install -D @elumixor/nitro-client
```

If you use Bun, you can also run the CLI through `bunx` without a local install.

## Configuration

Create a `nitro-client.config.ts` file in the project root:

```ts
export default {
  src: "src",
  out: "generated/client",
  tsconfig: "tsconfig.json",
  excludeDirs: "",
  excludeRoutes: "",
};
```

| Option          | Default            | Description                           |
| --------------- | ------------------ | ------------------------------------- |
| `src`           | `src`              | Source root containing `routes/`      |
| `out`           | `generated/client` | Output directory for generated client |
| `tsconfig`      | `tsconfig.json`    | TypeScript config path                |
| `excludeDirs`   | `""`               | Comma-separated directories to skip   |
| `excludeRoutes` | `""`               | Comma-separated routes to exclude     |

## Generate the client

```bash
bunx nitro-client
```

This scans `src/routes`, generates a client at `generated/client/index.ts`, and infers response types from your route handlers.

## Basic usage

```ts
import { NitroAPI } from "./generated/client";

const api = new NitroAPI({
  baseUrl: "http://localhost:3000",
});

// GET /users
const users = await api.users.$get();

// GET /users/:id — dynamic segments become callable
const user = await api.users("1").$get();

// POST /users — body is passed as the first argument
const created = await api.users.$post({ name: "Ada" });

// PATCH /users/:id
const updated = await api.users("1").$patch({ name: "Alan" });

// DELETE /users/:id
await api.users("1").$delete();
```

### Custom fetch

You can pass a custom `fetch` to inject headers, handle auth, etc.:

```ts
const api = new NitroAPI({
  baseUrl: "http://localhost:3000",
  fetch(input, init) {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  },
});
```

## Route conventions

- Route files must follow Nitro-style method suffixes: `.get.ts`, `.post.ts`, `.patch.ts`, `.put.ts`, `.delete.ts`.
- Dynamic route segments like `[id]` become callable path segments in the generated client.
- Kebab-case file names are converted to camelCase in the client (e.g. `blog-posts.get.ts` → `api.blogPosts.$get()`).

## Server-side handlers

The package provides a `handler` function (and `createHandler` factory) for defining route handlers with automatic validation:

```ts
import { handler } from "@elumixor/nitro-client/server";

// Simple handler
export default handler(async ({ router, event }) => {
  const id = router.id;
  return { id, name: "Ada" };
});
```

### With Zod validation

```ts
import { handler } from "@elumixor/nitro-client/server";
import { z } from "zod";

export default handler(
  {
    body: { name: z.string(), age: z.number() },
    query: { limit: z.number().optional() },
  },
  async ({ body, query }) => {
    // body: { name: string; age: number }
    // query: { limit?: number }
    return { success: true };
  },
);
```

The `body` and `query` types are automatically inferred and carried to the generated client.

### Custom handler with extensions

Use `createHandler` to inject shared context (e.g. auth) into every handler:

```ts
import { createHandler } from "@elumixor/nitro-client/server";

export const handler = createHandler({
  user: (event) => event.context.user as User | null,
});

// Now every handler gets `user` in context
export default handler(async ({ user }) => {
  if (!user) throw createError({ statusCode: 401 });
  return user;
});
```

### Handler context

Every handler receives a context object with:

| Property        | Type                                   | Description                      |
| --------------- | -------------------------------------- | -------------------------------- |
| `event`         | `H3Event`                              | Raw h3 event                     |
| `router`        | `Record<string, string>`               | Route params (lazy proxy)        |
| `signal`        | `AbortSignal`                          | Fires when client disconnects    |
| `formDataParts` | `Promise<MultiPartData[] \| undefined>` | Multipart form data (lazy)       |
| `body`          | inferred from schema                   | Validated body (if schema given) |
| `query`         | inferred from schema                   | Validated query (if schema given)|

## Streaming (SSE)

Route handlers defined as async generators automatically become streaming endpoints using Server-Sent Events:

### Server

```ts
export default handler(async function* ({ body }) {
  for (let i = 0; i < 10; i++) {
    yield { progress: i * 10 };
  }
  return { status: "done" };
});
```

Each `yield` sends an SSE message to the client. The `return` value is delivered as the final event.

### Client

```ts
const stream = api.tasks.$post({ input: "data" });

// Iterate over yielded events
for await (const event of stream) {
  console.log(event.progress); // 0, 10, 20, ...
}

// Get the return value
const result = await stream.done; // { status: "done" }
```

The `Stream` object supports:

- `for await...of` — iterate over yielded events
- `.done` — a `Promise` that resolves to the generator's return value
- `.id` — a `Promise<string>` that resolves when the job ID arrives (for background jobs)
- `.abort()` — cancel the stream

## Background jobs

Jobs let a streaming endpoint run in the background. Clients can disconnect and reconnect to the same job later, replaying buffered events.

### Server

```ts
import { handler, startJob, findJob, pushEvent, completeJob } from "@elumixor/nitro-client/server";

export default handler(async function* ({ router: { id } }) {
  // Check for an existing job first
  const existing = findJob(id);
  if (existing) return yield* existing;

  // Start a new background job
  yield startJob({ id });

  for (let i = 0; i < 100; i++) {
    yield { progress: i };
    pushEvent(id, { progress: i });
  }

  completeJob(id, { status: "done" });
  return { status: "done" };
});
```

### Client

```ts
// Start the job — id is available as a promise
const stream = api.longTask.$post({ input: "data" });
const id = await stream.id; // resolves once the server emits the job marker
saveJobId(id);

for await (const event of stream) {
  console.log(event.progress); // events that arrived while awaiting id are buffered
}

// Later — reconnect and replay buffered events
const resumed = api.longTask.$get({ jobId: savedId });
for await (const event of resumed) {
  console.log(event.progress);
}
```

### Job API

| Function                     | Description                                         |
| ---------------------------- | --------------------------------------------------- |
| `startJob({ id })`          | Returns a marker that signals the job ID to the client |
| `findJob(id)`               | Returns an async generator that replays buffered events, or `undefined` |
| `pushEvent(id, data)`       | Sends an event to all subscribers of the job        |
| `completeJob(id, returnValue)` | Marks the job as completed                       |
| `failJob(id, error)`        | Marks the job as failed                             |

## FormData / file uploads

FormData is detected automatically and sent as-is (not JSON-stringified):

### Server

```ts
export default handler(async function* ({ formDataParts }) {
  const parts = await formDataParts;
  // parts: MultiPartData[] — each has name, filename, type, data
  yield startJob({ id });
  // ... process files ...
  return { uploaded: parts?.length ?? 0 };
});
```

### Client

```ts
const fd = new FormData();
fd.append("file", fileBlob);
fd.append("name", "document.pdf");

const stream = api.upload.$post(fd);
for await (const event of stream) {
  console.log(event);
}
```

## Type inference

The generated client carries full type information through phantom properties. You never need to define API types manually — just extract them from the client:

### `$response` — response type

```ts
// Array element type
type User = (typeof api.users.$get.$response)[number];

// Object type
type UserDetail = typeof api.users.$param.$get.$response;

// Nested property
type Insight = UserDetail["insights"][number];
```

### `$request` — request body & query types

```ts
// Full request shape (has .body and .query)
type CreateUserRequest = typeof api.users.$post.$request;

// Just the body
type CreateUserBody = typeof api.users.$post.$request.body;
```

### `$yield` — streaming event type

```ts
// Type of each yielded event
type ProgressEvent = typeof api.tasks.$post.$yield;
```

### Dynamic route parameters

For dynamic routes, use `$param` to access the phantom types:

```ts
type UserResponse = typeof api.users.$param.$get.$response;
type AnswerBody = ReturnType<typeof api.sessions>["answer"]["$post"]["$request"];
```

## Notes

- Route files must follow Nitro-style method suffixes such as `.get.ts`, `.post.ts`, `.patch.ts`, `.put.ts`, and `.delete.ts`.
- Dynamic route segments like `[id]` become callable path segments in the generated client.
- Async generator handlers (`async function*`) automatically become SSE streaming endpoints.
- The `body` and `query` schemas are inferred into the `$request` phantom type on the generated client.
- Types like `Date`, `Decimal`, and `Buffer` are serialized as `string` in the generated client (since they cross the network as JSON).
