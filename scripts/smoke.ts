import { openRouterFromEnv } from "../src/ai/openrouter";
import { loadConfig, PayPalClient } from "../src/paypal/client";
import { createHandler } from "../src/server/app";
import { ProjectService } from "../src/server/service";
import { Store } from "../src/server/store";
import { AGREEMENT } from "./fixtures/sample-project";

const STATE_FILE = ".smoke.json";
const store = new Store(".smoke.db");
const handler = createHandler(new ProjectService(store, openRouterFromEnv(), new PayPalClient(loadConfig())));

async function call(method: string, path: string, body?: unknown, token?: string) {
  const response = await handler(
    new Request(`http://local${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const data = (await response.json()) as any;
  if (!response.ok) throw new Error(`${method} ${path.split("/").slice(0, 4).join("/")}: ${response.status} ${data.error}`);
  return data;
}

async function run() {
  const buyer = process.env.PAYPAL_SANDBOX_BUYER_EMAIL?.trim();
  if (!buyer) throw new Error("Set PAYPAL_SANDBOX_BUYER_EMAIL in .env");

  const created = await call("POST", "/api/projects", {
    title: "Lumen Coffee landing page",
    freelancerName: "Asha",
    clientName: "Lumen Coffee",
    clientEmail: buyer,
    hourlyRateCents: 10_000,
    agreement: AGREEMENT,
  });
  const id = created.project.id as string;
  const token = created.freelancerToken as string;
  const client = created.clientToken as string;
  const base = `/api/projects/${id}`;

  const draft = await call("POST", `${base}/scope/extract`, undefined, token);
  console.log(`Scope: ${draft.items.length} items extracted, ${draft.rejected.length} rejected`);

  const items = draft.items.map((item: { kind: string; text: string; sourceQuote: string }) => ({
    ...item,
    ...(item.kind === "deliverable" && /contact form/i.test(item.text) ? { priceCents: 5_000 } : {}),
  }));
  const project = await call("PUT", `${base}/scope`, { items }, token);
  const swapItem = project.scope.find((s: { priceCents?: number }) => s.priceCents !== undefined);
  if (!swapItem) throw new Error("The AI didn't extract the contact form deliverable");

  const messages = [
    "Could you also design us a new logo?",
    "Can you add online table booking with card payments?",
    "Please set up a Google Ads campaign for the launch.",
    "Can you fix the typo in the hero heading I sent you?",
  ];
  const requests = [];
  for (const text of messages) {
    const request = await call("POST", `${base}/requests`, { text }, token);
    console.log(`Label: ${request.label.padEnd(16)} ${text}`);
    requests.push(request);
  }
  const extras = requests.slice(0, 3);
  if (extras.some((r) => r.label !== "out_of_scope")) throw new Error("An extra wasn't labeled out of scope");

  for (const request of extras) {
    await call("PATCH", `${base}/requests/${request.id}`, { minutes: 120 }, token);
  }

  const before = await call("GET", base, undefined, token);
  console.log(`Running total: ${JSON.stringify(before.summary.unbilled)}`);

  const order = await call("POST", `${base}/orders`, { requestIds: extras.map((r) => r.id) }, token);
  const orderId = order.order.id as string;
  console.log(`Client note: ${order.order.message.replace(/\s+/g, " ").slice(0, 160)}...`);
  await call("POST", `${base}/orders/${orderId}/approve`, undefined, token);

  const chosen = await call("POST", `/api/client/${client}/orders/${orderId}/choices`, {
    choices: {
      [extras[0].id]: { type: "pay" },
      [extras[1].id]: { type: "swap", removedScopeItemId: swapItem.id },
      [extras[2].id]: { type: "defer" },
    },
  });
  console.log(`Amount due: ${chosen.orders[0].amountDueCents} cents (expected 35000)`);

  const invoiced = await call("POST", `/api/client/${client}/orders/${orderId}/invoice`);
  const result = invoiced.orders[0];
  await Bun.write(STATE_FILE, JSON.stringify({ id, token, client, orderId }, null, 2));
  console.log(`Invoice status: ${result.invoiceStatus}`);
  console.log(`Pay as the sandbox buyer here:\n${result.payerViewUrl}`);
}

async function check() {
  const { id, token, client, orderId } = (await Bun.file(STATE_FILE).json()) as Record<string, string>;
  const view = await call("POST", `/api/client/${client}/orders/${orderId}/refresh`);
  const order = view.orders[0];
  const full = await call("GET", `/api/projects/${id}`, undefined, token);

  console.log(
    JSON.stringify(
      {
        invoiceStatus: order.invoiceStatus,
        paid: order.paid,
        orderStatus: order.status,
        scopeItems: view.project.scope.length,
        later: view.project.later.map((l: { description: string }) => l.description),
        summary: full.summary,
        events: full.events.map((e: { type: string }) => e.type),
      },
      null,
      2,
    ),
  );
  console.log(order.paid ? "PASS: payment confirmed and scope updated." : "Not paid yet.");
}

try {
  if (process.argv[2] === "check") await check();
  else await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  store.close();
}
