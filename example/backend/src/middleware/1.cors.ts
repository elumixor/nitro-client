import { defineEventHandler, handleCors } from "h3";

export default defineEventHandler((event) => {
  if (
    handleCors(event, {
      origin: ["http://localhost:5199"],
      allowHeaders: ["Content-Type", "Authorization"],
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    })
  )
    return;
});

