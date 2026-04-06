import { handler } from "../utils/handler";
import { z } from "zod";

export default handler({ body: { from: z.number() } }, async function* ({ body }) {
  for (let i = body.from; i > 0; i--) {
    yield { count: i };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { done: true };
});
