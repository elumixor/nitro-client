import { api } from "../api";
import { sep, write } from "../log";

/**
 * SSE /sse-streaming — streaming via Server-Sent Events.
 *
 * The server handler is an async generator:
 *   async function* ({ body }) {
 *     for (let i = from; i > 0; i--) yield { count: i };
 *     return { done: true };
 *   }
 *
 * The client gets back a Stream object:
 *   - `for await...of`  — iterates over each yielded event
 *   - `.done`           — Promise resolving to the generator's return value
 *   - `.abort()`        — cancels the stream early
 */
export async function demoSseStreaming() {
  sep("SSE /sse-streaming", "sse");

  const stream = api.sseStreaming.$post({ from: 3 });

  // Each `yield` on the server arrives as a typed event.
  for await (const event of stream) {
    write(`  ${JSON.stringify(event)}`);
  }

  // `.done` resolves once the generator returns.
  const result = await stream.done;
  write(`  return: ${JSON.stringify(result)}`, "result");
}
