import { openRouterFromEnv } from "../ai/openrouter";
import { loadConfig, PayPalClient } from "../paypal/client";
import { createHandler } from "./app";
import { ProjectService } from "./service";
import { createStaticHandler } from "./static";
import { Store } from "./store";

const store = new Store(process.env.DATABASE_PATH?.trim() || "scopebill.db");
const service = new ProjectService(store, openRouterFromEnv(), new PayPalClient(loadConfig()));
const api = createHandler(service, undefined, undefined, process.env.PAYPAL_SANDBOX_BUYER_EMAIL?.trim());
const web = createStaticHandler("dist");

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  maxRequestBodySize: 128 * 1024,
  fetch(request) {
    const { pathname } = new URL(request.url);
    return pathname === "/api" || pathname.startsWith("/api/") ? api(request) : web(request);
  },
});

console.log(`ScopeBill running at ${server.url}`);
