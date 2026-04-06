import { wsHandler } from "@elumixor/nitro-client/server";
import { z } from "zod";

export default wsHandler(
  {
    send: { text: z.string(), user: z.string(), timestamp: z.number() },
    receive: { text: z.string() },
  },
  ({ send, receive, peerId }) => {
    console.log(`[ws] peer ${peerId} connected`);
    send({ text: "Welcome to the chat!", user: "system", timestamp: Date.now() });

    receive(({ text }) => {
      send({ text: `Echo: ${text}`, user: "bot", timestamp: Date.now() });
    });

    // Returning a cleanup function is optional.
    // If returned, it runs when the client disconnects.
    return () => {
      console.log(`[ws] peer ${peerId} disconnected`);
    };
  },
);
