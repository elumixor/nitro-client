import type { EventHandler, EventHandlerRequest, H3Event, MultiPartData } from "h3";
import { defineEventHandler, getRouterParam, getValidatedQuery, readMultipartFormData, readValidatedBody } from "h3";
import { type ZodType, z } from "zod";
import { sendSSEGenerator } from "./sse";

type SchemaInput = Record<string, ZodType>;
type Schemas = { body?: SchemaInput; query?: SchemaInput };

type InferSchema<S extends SchemaInput> = S extends ZodType
  ? z.infer<S>
  : { [K in keyof S]: S[K] extends ZodType ? z.infer<S[K]> : never };

type Inferred<S extends Schemas> = { [K in keyof S]: S[K] extends SchemaInput ? InferSchema<S[K]> : never };

export type BaseContext = {
  event: H3Event;
  router: Record<string, string>;
  signal: AbortSignal;
  formDataParts: Promise<MultiPartData[] | undefined>;
};

type ContextExtensions<E extends Record<string, (event: H3Event) => unknown>> = {
  [K in keyof E]: ReturnType<E[K]>;
};

const routerProxy = (event: H3Event) =>
  new Proxy({} as Record<string, string>, { get: (_, key: string) => getRouterParam(event, key) });

function isGeneratorFn(fn: (...args: never) => unknown): boolean {
  return fn.constructor.name === "AsyncGeneratorFunction" || fn.constructor.name === "GeneratorFunction";
}

function makeAbortSignal(event: H3Event): AbortSignal {
  const ac = new AbortController();
  event.node.res.on("close", () => ac.abort());
  return ac.signal;
}

function buildContext<E extends Record<string, (event: H3Event) => unknown>>(
  event: H3Event,
  extensions: E,
): BaseContext & ContextExtensions<E> {
  const base = { event, router: routerProxy(event), signal: makeAbortSignal(event) } as BaseContext;
  Reflect.defineProperty(base, "formDataParts", { get: () => readMultipartFormData(event), enumerable: true });
  for (const key of Object.keys(extensions)) {
    const getter = extensions[key];
    if (getter) Reflect.defineProperty(base, key, { get: () => getter(event), enumerable: true });
  }
  return base as BaseContext & ContextExtensions<E>;
}

/**
 * In-process direct invocation: skips HTTP body parsing and middleware. Pass pre-parsed
 * `body` / `query` and a (possibly synthetic) event whose `event.context` is already populated.
 * Used by `@elumixor/nitro-bot` to invoke tool routes as plain typed function calls. Not attached
 * to generator handlers (their result is an SSE stream).
 */
export type ExecutableEventHandler<R> = EventHandler<EventHandlerRequest, R> & {
  execute: (event: H3Event, body?: unknown, query?: unknown) => Promise<Awaited<R>>;
};

export function createHandler<E extends Record<string, (event: H3Event) => unknown>>(extensions?: E) {
  type Ctx = BaseContext & ContextExtensions<E>;
  const ext = extensions ?? ({} as E);

  function handler<S extends Schemas, R>(
    schemas: S,
    fn: (context: Inferred<S> & Ctx) => R,
  ): ExecutableEventHandler<R>;
  function handler<R>(fn: (context: Ctx) => R): ExecutableEventHandler<R>;
  function handler<S extends Schemas>(
    schemasOrFn: S | ((context: Ctx) => unknown),
    fn?: (context: Inferred<S> & Ctx) => unknown,
  ) {
    if (typeof schemasOrFn === "function") {
      if (isGeneratorFn(schemasOrFn)) {
        return defineEventHandler((event) => {
          const gen = schemasOrFn(buildContext(event, ext) as Ctx) as AsyncGenerator<unknown>;
          return sendSSEGenerator(event, gen);
        });
      }
      const eh = defineEventHandler((event) => schemasOrFn(buildContext(event, ext) as Ctx)) as ExecutableEventHandler<unknown>;
      eh.execute = async (event) => schemasOrFn(buildContext(event, ext) as Ctx) as Awaited<unknown>;
      return eh;
    }

    const { body, query } = schemasOrFn;

    if (fn && isGeneratorFn(fn)) {
      return defineEventHandler(async (event) => {
        const context = {
          ...buildContext(event, ext),
          body: body ? await readValidatedBody(event, (data) => z.object(body).parse(data)) : undefined,
          query: query ? await getValidatedQuery(event, (data) => z.object(query).parse(data)) : undefined,
        } as Inferred<S> & Ctx;
        const gen = fn(context) as AsyncGenerator<unknown>;
        return sendSSEGenerator(event, gen);
      });
    }

    const callFn = (event: H3Event, parsedBody: unknown, parsedQuery: unknown) =>
      (fn as (context: Inferred<S> & Ctx) => unknown)({
        ...buildContext(event, ext),
        body: parsedBody,
        query: parsedQuery,
      } as Inferred<S> & Ctx);

    const eh = defineEventHandler(async (event) => {
      const parsedBody = body ? await readValidatedBody(event, (data) => z.object(body).parse(data)) : undefined;
      const parsedQuery = query ? await getValidatedQuery(event, (data) => z.object(query).parse(data)) : undefined;
      return callFn(event, parsedBody, parsedQuery);
    }) as ExecutableEventHandler<unknown>;

    eh.execute = async (event, parsedBody, parsedQuery) =>
      callFn(event, parsedBody, parsedQuery) as Awaited<unknown>;

    return eh;
  }

  return handler;
}

export const handler = createHandler();
