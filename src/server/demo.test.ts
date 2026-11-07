import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { invalidCitations } from "../core/scope";
import type { JsonModel } from "../ai/openrouter";
import { createHandler } from "./app";
import { DEMO_AGREEMENT, DEMO_REQUESTS, DEMO_SCOPE } from "./demo";
import { ProjectService, type Payments } from "./service";
import { createStaticHandler } from "./static";
import { Store } from "./store";

const unused = new Proxy({}, {
  get() {
    throw new Error("The sample project must not call this service");
  },
});

const handlerWith = (email?: string) =>
  createHandler(
    new ProjectService(new Store(), unused as JsonModel, unused as Payments, () => {}),
    undefined,
    () => {},
    email,
  );

const post = (handler: ReturnType<typeof createHandler>) =>
  handler(new Request("http://test/api/demo", { method: "POST" }));

describe("sample project", () => {
  test("all citations exist in the agreement", () => {
    const quotes = [...DEMO_SCOPE.map((s) => s.sourceQuote), ...DEMO_REQUESTS.flatMap((r) => r.citedQuotes)];
    expect(invalidCitations(quotes, DEMO_AGREEMENT)).toEqual([]);
  });

  test("is created without AI or PayPal calls", async () => {
    const handler = handlerWith("buyer@personal.example.com");
    const response = await post(handler);
    expect(response.status).toBe(201);
    const created = (await response.json()) as { project: { id: string }; freelancerToken: string };

    const view = (await (
      await handler(
        new Request(`http://test/api/projects/${created.project.id}`, {
          headers: { Authorization: `Bearer ${created.freelancerToken}` },
        }),
      )
    ).json()) as { requests: unknown[]; project: { scopeConfirmed: boolean }; summary: { unbilled: unknown } };

    expect(view.project.scopeConfirmed).toBe(true);
    expect(view.requests).toHaveLength(6);
    expect(view.summary.unbilled).toEqual({ requestCount: 4, minutes: 495, amountCents: 82_500 });
  });

  test("is unavailable without a sandbox buyer", async () => {
    expect((await post(handlerWith())).status).toBe(409);
  });

  test("rejects a non-sandbox buyer", async () => {
    expect((await post(handlerWith("real@gmail.com"))).status).toBe(409);
  });
});

describe("static files", () => {
  const parent = mkdtempSync(join(tmpdir(), "scopebill-"));
  const dist = join(parent, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<h1>app</h1>");
  writeFileSync(join(parent, "secret.env"), "KEY=secret");
  const web = createStaticHandler(dist);

  test("serves the app with security headers", async () => {
    const response = await web(new Request("http://test/"));
    expect(await response.text()).toContain("app");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test.each(["/..%2Fsecret.env", "/%2e%2e/secret.env", "/missing.js"])("won't serve %s", async (path) => {
    const response = await web(new Request(`http://test${path}`));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });

  test("rejects a malformed path and other methods", async () => {
    expect((await web(new Request("http://test/%E0%A4%A"))).status).toBe(400);
    expect((await web(new Request("http://test/", { method: "POST" }))).status).toBe(405);
  });
});
