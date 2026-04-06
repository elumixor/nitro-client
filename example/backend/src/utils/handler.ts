import { createHandler } from "@elumixor/nitro-client/server";

/**
 * Custom handler factory with auth context.
 *
 * createHandler() lets you inject shared context into every route handler.
 * The middleware (2.auth.ts) already puts the user on event.context —
 * this just surfaces it as a first-class typed property in every handler.
 *
 * Usage in a route:
 *   export default handler(({ user }) => {
 *     if (!user) throw createError({ statusCode: 401 });
 *     return { token: user.token };
 *   });
 */
export const handler = createHandler({
  user: (event) => event.context.user as { token: string } | null,
});
