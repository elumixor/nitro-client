import { api } from "../api";
import { sep, write } from "../log";

/**
 * WS /rooms/:room/chat.ws — a WebSocket on a *dynamic* route.
 *
 *   const socket = api.rooms("general").chat.$ws();
 *
 * The room segment is part of the path. Server-side it's read from `ctx.url` (see the route),
 * so it resolves even on adapters that don't expose router params on a WS upgrade.
 */
export async function demoWebSocketRoom() {
  sep("WS /rooms/general/chat.ws", "ws");

  const socket = api.rooms("general").chat.$ws();
  await socket.connected;
  write("  connected", "status");

  // First inbound message is the join confirmation, carrying the resolved room name.
  const joined = await socket.next();
  write(`  ${JSON.stringify(joined)}`);

  socket.send({ text: "Hello, room!" });
  const echo = await socket.next();
  write(`  ${JSON.stringify(echo)}`);

  socket.close();
  write("  closed", "status");
}
