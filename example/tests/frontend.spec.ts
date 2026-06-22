import { test, expect } from "@playwright/test";

test.describe("Frontend demo UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("page loads with all command buttons", async ({ page }) => {
    await expect(page.locator("#btn-hello")).toBeVisible();
    await expect(page.locator("#btn-greet")).toBeVisible();
    await expect(page.locator("#btn-countdown")).toBeVisible();
    await expect(page.locator("#btn-process")).toBeVisible();
    await expect(page.locator("#btn-chat")).toBeVisible();
  });

  test("GET /simple-get demo", async ({ page }) => {
    await page.click("#btn-hello");
    await expect(page.locator("#log")).toContainText("Hello from nitro-client!", { timeout: 5000 });
  });

  test("POST /post-with-body demo", async ({ page }) => {
    await page.click("#btn-greet");
    await expect(page.locator("#log")).toContainText("Hello, World!", { timeout: 5000 });
  });

  test("SSE /sse-streaming demo", async ({ page }) => {
    await page.click("#btn-countdown");
    await expect(page.locator("#log")).toContainText('"count":1', { timeout: 10000 });
    await expect(page.locator("#log")).toContainText('"done":true', { timeout: 10000 });
  });

  test("SSE /sse-background-job demo", async ({ page }) => {
    await page.click("#btn-process");
    await expect(page.locator("#log")).toContainText("jobId:", { timeout: 10000 });
    await expect(page.locator("#log")).toContainText("Completed: my-task", { timeout: 15000 });
  });

  test("WS /websocket demo connects", async ({ page }) => {
    await page.click("#btn-chat");
    // Nitro's experimental WebSocket in dev mode may not deliver messages
    // reliably (the crossws open hook timing depends on the adapter).
    // Verify the connection itself succeeds.
    await expect(page.locator("#log")).toContainText("connected", { timeout: 10000 });
  });

  test("WS /rooms/:room/chat dynamic-param demo connects", async ({ page }) => {
    await page.click("#btn-room");
    // Same dev-mode caveat as the static WS demo — assert the upgrade itself succeeds.
    await expect(page.locator("#log")).toContainText("connected", { timeout: 10000 });
  });

  test("clear log button works", async ({ page }) => {
    await page.click("#btn-hello");
    await expect(page.locator("#log")).toContainText("Hello from nitro-client!", { timeout: 5000 });
    await page.click("#btn-clear");
    await expect(page.locator("#log")).toContainText("Click a command to see output");
  });
});
