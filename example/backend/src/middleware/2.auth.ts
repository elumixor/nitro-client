import { defineEventHandler, getHeader } from "h3";

export default defineEventHandler((event) => {
  const header = getHeader(event, "authorization");
  event.context.user = header?.startsWith("Bearer ") ? { token: header.slice(7) } : null;
});
