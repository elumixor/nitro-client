import { createEventStream, type H3Event } from "h3";
import { completeJob, failJob, isStartJob, pushEvent, registerJob, type StartJobMarker } from "./jobs";

export function interruptable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const { promise: p, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  return p;
}

type SSEStream = ReturnType<typeof createEventStream>;

async function safePush(stream: SSEStream, msg: { event?: string; data: string }) {
  try {
    await stream.push(msg);
  } catch {
    // Client disconnected — silently ignore
  }
}

export async function sendSSEGenerator(event: H3Event, gen: AsyncGenerator<unknown, unknown>): Promise<unknown> {
  // Execute generator until first yield — pre-flight errors (auth, 404) become proper HTTP errors
  const firstResult = await gen.next();

  // Generator completed immediately — return value as plain JSON (no SSE)
  if (firstResult.done) return firstResult.value;

  // First yield succeeded — now start the SSE stream
  const stream = createEventStream(event);

  const jobMarker = isStartJob(firstResult.value) ? (firstResult.value as StartJobMarker) : null;
  const jobId = jobMarker?.id ?? null;

  if (jobId) registerJob(jobId);

  // event.waitUntil is a Nitro extension (not in h3 types)
  const waitUntil = (event as unknown as { waitUntil: (p: Promise<unknown>) => void }).waitUntil;

  waitUntil(
    (async () => {
      try {
        if (jobId) {
          await safePush(stream, { event: "__job", data: JSON.stringify({ id: jobId }) });
        } else {
          await safePush(stream, { data: JSON.stringify(firstResult.value) });
        }

        // Manual .next() loop to capture return value (for await...of discards it)
        let result = await gen.next();
        while (!result.done) {
          const value = result.value;
          await safePush(stream, { data: JSON.stringify(value) });
          if (jobId) pushEvent(jobId, value);
          result = await gen.next();
        }

        // Generator returned — send return value
        const returnValue = result.value;
        if (returnValue !== undefined) {
          await safePush(stream, { event: "__return", data: JSON.stringify(returnValue) });
        }
        if (jobId) completeJob(jobId, returnValue);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (err.name !== "AbortError") {
          await safePush(stream, { event: "__error", data: JSON.stringify({ message: err.message }) });
          if (jobId) failJob(jobId, err);
        }
      } finally {
        await stream.close();
      }
    })(),
  );

  return stream.send();
}
