import { api } from "../api";
import { sep, write } from "../log";

/**
 * SSE /sse-background-job — long-running job that survives client disconnects.
 *
 * The server registers the job with `startJob({ id })`, then clients can
 * reconnect later via `api.sseBackgroundJob.$get({ jobId })` to replay events.
 *
 * Key additions over plain streaming:
 *   - `.id`  — Promise<string> resolving when the server emits the job marker.
 *              Events that arrive before `.id` resolves are buffered automatically.
 *   - Server API: startJob / pushEvent / completeJob / failJob / findJob
 */
export async function demoSseBackgroundJob() {
  sep("SSE /sse-background-job", "sse");
  try {
    const stream = api.sseBackgroundJob.$post({ task: "my-task" });

    // `.id` resolves once the server emits the job marker — safe to persist.
    const jobId = await stream.id;
    write(`  jobId: ${jobId}`, "meta");

    // Iterate events; any that arrived while awaiting `.id` are replayed first.
    for await (const event of stream) {
      write(`  ${JSON.stringify(event)}`);
    }

    const result = await stream.done;
    write(`  return: ${JSON.stringify(result)}`, "result");
  } catch (e) {
    write(`  error: ${(e as Error).message}`, "err");
  }
}
