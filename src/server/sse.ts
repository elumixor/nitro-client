import { createEventStream, type H3Event } from "h3";

export function interruptable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const { promise: p, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  return p;
}

export async function sendSSEGenerator(event: H3Event, gen: AsyncGenerator<unknown>): Promise<void> {
  // Execute generator until first yield — pre-flight errors (auth, 404) become proper HTTP errors
  const firstResult = await gen.next();
  if (firstResult.done) return;

  // First yield succeeded — now start the SSE stream
  const stream = createEventStream(event);
  const ac = new AbortController();
  event.node.res.on("close", () => ac.abort());

  // event.waitUntil is a Nitro extension (not in h3 types)
  (event as unknown as { waitUntil: (p: Promise<unknown>) => void }).waitUntil(
    (async () => {
      try {
        await stream.push({ data: JSON.stringify(firstResult.value) });
        for await (const value of gen) {
          if (ac.signal.aborted) break;
          await stream.push({ data: JSON.stringify(value) });
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (err.name !== "AbortError") {
          try {
            await stream.push({ data: JSON.stringify({ __error: err.message }) });
          } catch {}
        }
      } finally {
        await stream.close();
      }
    })(),
  );

  return stream.send();
}
