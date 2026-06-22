import { wsHandler } from "@elumixor/nitro-client/server";
import { z } from "zod";

/**
 * Dynamic-param WebSocket. The room name lives in the route (`/rooms/:room/chat.ws`).
 *
 * On adapters where the h3 event isn't attached to the crossws peer (e.g. Bun), `router.room`
 * is undefined — so we parse the room from `ctx.url` (the upgrade request pathname), which is
 * always populated. This is the whole reason `ctx.url` exists.
 *
 * Note `send` mixes a required field (`text`) with optional ones (`room`, `system`): each send()
 * only needs to pass what it sets, because optional schema fields map to optional payload keys.
 */
export default wsHandler(
  {
    send: { text: z.string(), room: z.string().optional(), system: z.boolean().optional() },
    receive: { text: z.string() },
  },
  ({ send, receive, router, url }) => {
    const room = router.room ?? url.match(/\/rooms\/([^/]+)\/chat\.ws/)?.[1] ?? "unknown";

    send({ text: `Joined room "${room}"`, room, system: true });

    receive(({ text }) => {
      send({ text: `[${room}] ${text}` });
    });
  },
);
