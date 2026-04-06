import { api } from "../api";
import { sep, write } from "../log";

/**
 * POST /post-with-body — request with a typed JSON body.
 *
 *   const res = await api.postWithBody.$post({ name: "World" });
 *
 * The body shape is inferred from the server-side handler schema,
 * so passing the wrong shape is a compile-time error.
 */
export async function demoPostWithBody() {
  sep("POST /post-with-body", "post");
  const res = await api.postWithBody.$post({ name: "World" });
  write(JSON.stringify(res, null, 2));
}
