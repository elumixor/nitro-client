import { test, expect } from "@playwright/test";

const API = "http://localhost:3456";

test.describe("GET /simple-get", () => {
  test("returns message and authenticated status", async ({ request }) => {
    const res = await request.get(`${API}/simple-get`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toEqual({ message: "Hello from nitro-client!", authenticated: false });
  });

  test("detects auth header", async ({ request }) => {
    const res = await request.get(`${API}/simple-get`, {
      headers: { Authorization: "Bearer test-token" },
    });
    const body = await res.json();
    expect(body.authenticated).toBe(true);
  });
});

test.describe("POST /post-with-body", () => {
  test("returns greeting with name", async ({ request }) => {
    const res = await request.post(`${API}/post-with-body`, {
      data: { name: "World" },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toEqual({ greeting: "Hello, World!" });
  });

  test("rejects missing body field", async ({ request }) => {
    const res = await request.post(`${API}/post-with-body`, {
      data: {},
    });
    expect(res.ok()).toBe(false);
  });
});

test.describe("POST /sse-streaming", () => {
  test("streams countdown events and returns done", async ({ request }) => {
    const res = await request.post(`${API}/sse-streaming`, {
      headers: { Accept: "text/event-stream" },
      data: { from: 3 },
    });
    expect(res.ok()).toBe(true);

    const text = await res.text();
    // Should contain countdown events and a return value
    expect(text).toContain('"count":3');
    expect(text).toContain('"count":2');
    expect(text).toContain('"count":1');
    expect(text).toContain("__return");
    expect(text).toContain('"done":true');
  });
});

test.describe("POST /sse-background-job", () => {
  test("emits job marker and step events", async ({ request }) => {
    const res = await request.post(`${API}/sse-background-job`, {
      headers: { Accept: "text/event-stream" },
      data: { task: "test-task" },
    });
    expect(res.ok()).toBe(true);

    const text = await res.text();
    // Should contain job marker
    expect(text).toContain("__job");
    // Should contain step events
    expect(text).toContain('"step":1');
    expect(text).toContain('"step":4');
    // Should contain return value
    expect(text).toContain("__return");
    expect(text).toContain("Completed: test-task");
  });
});
