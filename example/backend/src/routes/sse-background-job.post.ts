import { handler } from "../utils/handler";
import { startJob, findJob } from "@elumixor/nitro-client/server";
import { z } from "zod";

export default handler(
  { body: { task: z.string(), jobId: z.string().optional() } },
  async function* ({ body }) {
    // If a jobId is provided, reconnect to the existing job
    if (body.jobId) {
      const existing = findJob(body.jobId);
      if (existing) return yield* existing;
    }

    // Start a new background job
    const id = `job-${Date.now()}`;
    yield startJob({ id });

    // Simulate processing steps
    const steps = [`Parsing "${body.task}"`, "Validating", "Processing", "Finalizing"];
    for (let i = 0; i < steps.length; i++) {
      await new Promise((r) => setTimeout(r, 300));
      yield { step: i + 1, total: steps.length, message: steps[i]! };
    }

    return { result: `Completed: ${body.task}` };
  },
);
