import { handler } from "../utils/handler";
import { z } from "zod";

export default handler({ body: { name: z.string() } }, ({ body }) => {
  return { greeting: `Hello, ${body.name}!` };
});
