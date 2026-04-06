import { api } from "../api";
import { sep, write } from "../log";

/**
 * WS /websocket — full-duplex real-time communication.
 *
 *   const socket = api.websocket.$ws();
 *   await socket.connected;          // wait for handshake
 *   socket.send({ text });           // typed outbound message
 *   for await (const msg of socket)  // typed inbound messages
 *   socket.close();                  // graceful close
 *
 * The Socket is async-iterable; the loop ends when the server closes
 * or `socket.close()` is called.
 */
export async function demoWebSocket() {
  sep("WS /websocket", "ws");

  const socket = api.websocket.$ws();

  // Wait for the WebSocket handshake before sending.
  await socket.connected;
  write("  connected", "status");

  // Read the welcome message.
  const welcome = await socket.next();
  write(`  ${JSON.stringify(welcome)}`);

  // Send messages and read each echo back.
  for (const text of ["Hello!", "How are you?", "Goodbye!"]) {
    socket.send({ text });
    const echo = await socket.next();
    write(`  ${JSON.stringify(echo)}`);
  }

  socket.close();

  write("  closed", "status");
}
