import { handler } from "@elumixor/nitro-client/server";

export default handler(() => {
  return { message: "Hello from nitro-client!" };
});
