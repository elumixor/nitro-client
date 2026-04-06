import { handler } from "../utils/handler";

export default handler(({ user }) => {
  return { message: "Hello from nitro-client!", authenticated: user !== null };
});
