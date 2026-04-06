import { api } from "../api";
import { sep, write } from "../log";

/**
 * GET /simple-get — simplest possible request.
 *
 *   const res = await api.simpleGet.$get();
 *
 * No body, no params — returns fully typed JSON.
 */
export async function demoSimpleGet() {
  sep("GET /simple-get", "get");
  const res = await api.simpleGet.$get();
  console.log(res);
  write(JSON.stringify(res, null, 2));
}
