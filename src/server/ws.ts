import type { EventHandler, EventHandlerRequest, H3Event } from "h3";
import { defineWebSocketHandler, getRouterParam } from "h3";
import { type ZodType, z } from "zod";

type SchemaInput = Record<string, ZodType>;
type InferSchema<S extends SchemaInput> = { [K in keyof S]: S[K] extends ZodType ? z.infer<S[K]> : never };

type WsSchemas = { send?: SchemaInput; receive?: SchemaInput };

export type WsContext<S extends WsSchemas = WsSchemas> = {
  send: (data: S["send"] extends SchemaInput ? InferSchema<S["send"]> : unknown) => void;
  /** Register a handler for incoming messages */
  receive: (cb: (data: S["receive"] extends SchemaInput ? InferSchema<S["receive"]> : unknown) => void) => void;
  close: (code?: number, reason?: string) => void;
  /** The raw h3 event from the upgrade request (may be undefined depending on adapter) */
  event: H3Event | undefined;
  /** Lazy router param proxy */
  router: Record<string, string>;
  /** The crossws Peer id */
  peerId: string;
};

type ContextExtensions<E extends Record<string, (event: H3Event) => unknown>> = {
  [K in keyof E]: ReturnType<E[K]>;
};

type Cleanup = undefined | (() => void);

const routerProxy = (event: H3Event | undefined) =>
  new Proxy({} as Record<string, string>, {
    get: (_, key: string) => (event ? getRouterParam(event, key) : undefined),
  });

export function createWsHandler<E extends Record<string, (event: H3Event) => unknown>>(extensions?: E) {
  type Ctx = WsContext & ContextExtensions<E>;
  const ext = extensions ?? ({} as E);

  function wsHandler<S extends WsSchemas>(
    schemas: S,
    fn: (context: WsContext<S> & ContextExtensions<E>) => Cleanup,
  ): EventHandler<EventHandlerRequest, never>;
  function wsHandler(fn: (context: Ctx) => Cleanup): EventHandler<EventHandlerRequest, never>;
  function wsHandler<S extends WsSchemas>(
    schemasOrFn: S | ((context: Ctx) => Cleanup),
    fn?: (context: WsContext<S> & ContextExtensions<E>) => Cleanup,
  ) {
    const schemas = typeof schemasOrFn === "function" ? undefined : schemasOrFn;
    const callback = typeof schemasOrFn === "function" ? schemasOrFn : fn;
    if (!callback) throw new Error("wsHandler requires a callback function");

    const receiveSchema = schemas?.receive ? z.object(schemas.receive) : null;

    // Store per-peer state
    const peerState = new Map<string, { listeners: Array<(data: unknown) => void>; cleanup?: () => void }>();

    return defineWebSocketHandler({
      open(peer) {
        const peerAny = peer as unknown as { ctx?: { event?: H3Event } };
        const event = peerAny.ctx?.event;
        const listeners: Array<(data: unknown) => void> = [];
        const state = { listeners, cleanup: undefined as (() => void) | undefined };
        peerState.set(peer.id, state);

        const ctx: WsContext = {
          send: (data) => peer.send(JSON.stringify(data)),
          receive: (cb) => listeners.push(cb),
          close: (code, reason) => peer.close(code, reason),
          event,
          router: routerProxy(event),
          peerId: peer.id,
        };

        // Add extensions
        if (event) {
          for (const key of Object.keys(ext)) {
            const getter = ext[key];
            if (getter) Reflect.defineProperty(ctx, key, { get: () => getter(event), enumerable: true });
          }
        }

        // biome-ignore lint/suspicious/noExplicitAny: runtime context is built dynamically
        const result = callback(ctx as any);
        if (typeof result === "function") state.cleanup = result;
      },
      message(peer, message) {
        const state = peerState.get(peer.id);
        if (!state) return;
        let data: unknown;
        try {
          data = JSON.parse(message.text());
        } catch {
          data = message.text();
        }
        if (receiveSchema) data = receiveSchema.parse(data);
        for (const listener of state.listeners) listener(data);
      },
      close(peer) {
        const state = peerState.get(peer.id);
        if (!state) return;
        state.cleanup?.();
        peerState.delete(peer.id);
      },
      error(peer) {
        const state = peerState.get(peer.id);
        if (!state) return;
        state.cleanup?.();
        peerState.delete(peer.id);
      },
    });
  }

  return wsHandler;
}

export const wsHandler = createWsHandler();
