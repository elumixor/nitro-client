import type { EventHandler, EventHandlerRequest, H3Event } from "h3";
import { defineEventHandler, getRouterParam, getValidatedQuery, readValidatedBody } from "h3";
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
  user: unknown;
  router: Record<string, string>;
  signal: AbortSignal;
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

export function handler<S extends Schemas, R>(
  schemas: S,
  fn: (context: Inferred<S> & BaseContext) => R,
): EventHandler<EventHandlerRequest, R>;
export function handler<R>(fn: (context: BaseContext) => R): EventHandler<EventHandlerRequest, R>;
export function handler<S extends Schemas>(
  schemasOrFn: S | ((context: BaseContext) => unknown),
  fn?: (context: Inferred<S> & BaseContext) => unknown,
) {
  if (typeof schemasOrFn === "function") {
    if (isGeneratorFn(schemasOrFn)) {
      return defineEventHandler((event) => {
        const gen = schemasOrFn({
          event,
          user: event.context.user,
          router: routerProxy(event),
          signal: makeAbortSignal(event),
        }) as AsyncGenerator<unknown>;
        return sendSSEGenerator(event, gen);
      });
    }
    return defineEventHandler(async (event) =>
      schemasOrFn({ event, user: event.context.user, router: routerProxy(event), signal: makeAbortSignal(event) }),
    );
  }

  const { body, query } = schemasOrFn;

  if (fn && isGeneratorFn(fn)) {
    return defineEventHandler(async (event) => {
      const context = {
        event,
        body: body ? await readValidatedBody(event, (data) => z.object(body).parse(data)) : undefined,
        query: query ? await getValidatedQuery(event, (data) => z.object(query).parse(data)) : undefined,
        router: routerProxy(event),
        user: event.context.user,
        signal: makeAbortSignal(event),
      } as Inferred<S> & BaseContext;
      const gen = fn(context) as AsyncGenerator<unknown>;
      return sendSSEGenerator(event, gen);
    });
  }

  return defineEventHandler(async (event) =>
    (fn as (context: Inferred<S> & BaseContext) => unknown)({
      event,
      body: body ? await readValidatedBody(event, (data) => z.object(body).parse(data)) : undefined,
      query: query ? await getValidatedQuery(event, (data) => z.object(query).parse(data)) : undefined,
      router: routerProxy(event),
      user: event.context.user,
      signal: makeAbortSignal(event),
    } as Inferred<S> & BaseContext),
  );
}
