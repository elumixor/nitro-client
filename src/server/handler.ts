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

export type BaseContext<User = unknown> = {
  event: H3Event;
  user: User;
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

export function createHandler<User = unknown>() {
  type Ctx = BaseContext<User>;

  function handler<S extends Schemas, R>(
    schemas: S,
    fn: (context: Inferred<S> & Ctx) => R,
  ): EventHandler<EventHandlerRequest, R>;
  function handler<R>(fn: (context: Ctx) => R): EventHandler<EventHandlerRequest, R>;
  function handler<S extends Schemas>(
    schemasOrFn: S | ((context: Ctx) => unknown),
    fn?: (context: Inferred<S> & Ctx) => unknown,
  ) {
    if (typeof schemasOrFn === "function") {
      if (isGeneratorFn(schemasOrFn)) {
        return defineEventHandler((event) => {
          const gen = schemasOrFn({
            event,
            user: event.context.user,
            router: routerProxy(event),
            signal: makeAbortSignal(event),
          } as Ctx) as AsyncGenerator<unknown>;
          return sendSSEGenerator(event, gen);
        });
      }
      return defineEventHandler(async (event) =>
        schemasOrFn({
          event,
          user: event.context.user,
          router: routerProxy(event),
          signal: makeAbortSignal(event),
        } as Ctx),
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
        } as Inferred<S> & Ctx;
        const gen = fn(context) as AsyncGenerator<unknown>;
        return sendSSEGenerator(event, gen);
      });
    }

    return defineEventHandler(async (event) =>
      (fn as (context: Inferred<S> & Ctx) => unknown)({
        event,
        body: body ? await readValidatedBody(event, (data) => z.object(body).parse(data)) : undefined,
        query: query ? await getValidatedQuery(event, (data) => z.object(query).parse(data)) : undefined,
        router: routerProxy(event),
        user: event.context.user,
        signal: makeAbortSignal(event),
      } as Inferred<S> & Ctx),
    );
  }

  return handler;
}

export const handler = createHandler();
