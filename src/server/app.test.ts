import { beforeEach, describe, expect, test } from "bun:test";
import type { JsonModel, JsonRequest, JsonResponse } from "../ai/openrouter";
import type { InvoiceState, NewInvoice } from "../paypal/client";
import { createHandler } from "./app";
import { ProjectService, type Payments } from "./service";
import { Store } from "./store";

const AGREEMENT = "One landing page. Logo design is not included. FAQ page.";

class FakeModel implements JsonModel {
  failing = false;
  async completeJson<T>(request: JsonRequest): Promise<JsonResponse<T>> {
    if (this.failing) throw new Error("model down");
    const data = (() => {
      if (request.schemaName === "scope_items") {
        return { items: [{ kind: "deliverable", text: "Landing page", source_quote: "One landing page" }] };
      }
      if (request.schemaName === "change_order_message") return { message: "Happy to help with these." };
      const asksLogo = request.user.includes("logo");
      return {
        label: asksLogo ? "out_of_scope" : "in_scope",
        reason: "Checked against the agreement.",
        cited_quotes: [asksLogo ? "Logo design is not included." : "One landing page"],
        suggested_minutes: asksLogo ? 120 : null,
        injection_suspected: false,
      };
    })();
    return { data: data as T, model: "fake", usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } };
  }
}

class FakePayments implements Payments {
  invoices = new Map<string, InvoiceState>();
  created: Array<{ input: NewInvoice; requestId: string }> = [];
  failCreate = false;
  totalOverride: string | null = null;

  async createDraftInvoice(input: NewInvoice, requestId: string): Promise<InvoiceState> {
    if (this.failCreate) throw new Error("PayPal down, secret detail");
    this.created.push({ input, requestId });
    const cents = input.items.reduce((sum, i) => sum + Math.round(Number(i.unitAmount) * 100) * i.quantity, 0);
    const invoice: InvoiceState = {
      id: `INV-${this.created.length}`,
      status: "DRAFT",
      total: this.totalOverride ?? (cents / 100).toFixed(2),
      currency: "USD",
      paidAmount: null,
      payerViewUrl: null,
      transactionIds: [],
    };
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }
  async sendInvoice(invoiceId: string): Promise<void> {
    const invoice = this.invoices.get(invoiceId)!;
    invoice.status = "SENT";
    invoice.payerViewUrl = `https://sandbox.example/${invoiceId}`;
  }
  async getInvoice(invoiceId: string): Promise<InvoiceState> {
    return { ...this.invoices.get(invoiceId)! };
  }
  reminded: string[] = [];
  cancelled: string[] = [];
  async remindInvoice(invoiceId: string): Promise<void> {
    this.reminded.push(invoiceId);
  }
  async cancelInvoice(invoiceId: string): Promise<void> {
    this.cancelled.push(invoiceId);
    this.invoices.get(invoiceId)!.status = "CANCELLED";
  }
  pay(invoiceId: string, status = "PAID"): void {
    const invoice = this.invoices.get(invoiceId)!;
    Object.assign(invoice, { status, paidAmount: invoice.total, transactionIds: ["TX1"] });
  }
}

let model: FakeModel;
let payments: FakePayments;
let handler: (request: Request) => Promise<Response>;
let webhookHandler: (request: Request) => Promise<Response>;
let webhookGenuine: boolean;

beforeEach(() => {
  model = new FakeModel();
  payments = new FakePayments();
  webhookGenuine = true;
  const service = new ProjectService(new Store(), model, payments, () => {});
  handler = createHandler(service, { projectsPerHour: 3, aiCallsPerDay: 100 }, () => {});
  webhookHandler = createHandler(service, undefined, () => {}, undefined, async () => webhookGenuine);
});

const webhook = async (event: unknown, target = webhookHandler) => {
  const response = await target(
    new Request("http://test/api/paypal/webhook", { method: "POST", body: JSON.stringify(event) }),
  );
  return { status: response.status, body: (await response.json()) as any };
};

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await handler(
    new Request(`http://test${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as any };
};

const newProject = (overrides = {}) => ({
  title: "Lumen",
  freelancerName: "Asha",
  clientName: "Lumen Coffee",
  clientEmail: "buyer@personal.example.com",
  hourlyRateCents: 10_000,
  agreement: AGREEMENT,
  ...overrides,
});

async function setup() {
  const created = (await call("POST", "/api/projects", newProject())).body;
  const id = created.project.id as string;
  const token = created.freelancerToken as string;
  const client = created.clientToken as string;
  await call(
    "PUT",
    `/api/projects/${id}/scope`,
    {
      items: [
        { kind: "deliverable", text: "Landing page", sourceQuote: "One landing page" },
        { kind: "deliverable", text: "FAQ page", sourceQuote: "FAQ page", priceCents: 5_000 },
      ],
    },
    token,
  );
  return { id, token, client };
}

async function approvedOrder(s: { id: string; token: string }) {
  const request = (await call("POST", `/api/projects/${s.id}/requests`, { text: "Design a new logo" }, s.token)).body;
  const order = (await call("POST", `/api/projects/${s.id}/orders`, { requestIds: [request.id] }, s.token)).body;
  const orderId = order.order.id as string;
  await call("POST", `/api/projects/${s.id}/orders/${orderId}/approve`, undefined, s.token);
  return { requestId: request.id as string, orderId };
}

describe("access", () => {
  test("freelancer routes need the right token", async () => {
    const s = await setup();
    expect((await call("GET", `/api/projects/${s.id}`)).status).toBe(401);
    expect((await call("GET", `/api/projects/${s.id}`, undefined, "wrong")).status).toBe(401);
    expect((await call("GET", `/api/projects/${s.id}`, undefined, s.client)).status).toBe(401);
    expect((await call("GET", `/api/projects/${s.id}`, undefined, s.token)).status).toBe(200);
  });

  test("a freelancer token can't open another project", async () => {
    const a = await setup();
    const b = await setup();
    expect((await call("GET", `/api/projects/${b.id}`, undefined, a.token)).status).toBe(401);
  });

  test("an unknown client link fails", async () => {
    expect((await call("GET", "/api/client/nope")).status).toBe(404);
  });

  test("the client view hides drafts, the rate and AI details", async () => {
    const s = await setup();
    const request = (await call("POST", `/api/projects/${s.id}/requests`, { text: "Design a new logo" }, s.token)).body;
    await call("POST", `/api/projects/${s.id}/orders`, { requestIds: [request.id] }, s.token);

    const { body } = await call("GET", `/api/client/${s.client}`);
    expect(body.orders).toHaveLength(0);
    const text = JSON.stringify(body);
    expect(text).not.toContain("hourlyRateCents");
    expect(text).not.toContain("freelancerToken");
    expect(text).not.toContain("injectionSuspected");
    expect(text).not.toContain(s.token);
  });
});

describe("validation", () => {
  test("only sandbox client emails are accepted", async () => {
    const result = await call("POST", "/api/projects", newProject({ clientEmail: "real@gmail.com" }));
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("sandbox");
  });

  test.each([
    [{ title: "" }, "title"],
    [{ hourlyRateCents: 10.5 }, "hourlyRateCents"],
    [{ clientEmail: "not-an-email" }, "clientEmail"],
    [{ agreement: "x".repeat(30_001) }, "agreement"],
  ])("rejects bad project input %#", async (overrides, field) => {
    const result = await call("POST", "/api/projects", newProject(overrides));
    expect(result.status).toBe(400);
    expect(result.body.error).toContain(field);
  });

  test("invalid JSON gets a clear error", async () => {
    const response = await handler(new Request("http://test/api/projects", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
  });

  test("project creation is rate limited", async () => {
    for (let i = 0; i < 3; i++) expect((await call("POST", "/api/projects", newProject())).status).toBe(201);
    expect((await call("POST", "/api/projects", newProject())).status).toBe(429);
  });
});

describe("requests and totals", () => {
  test("requests need a confirmed scope", async () => {
    const created = (await call("POST", "/api/projects", newProject())).body;
    const result = await call("POST", `/api/projects/${created.project.id}/requests`, { text: "Logo" }, created.freelancerToken);
    expect(result.status).toBe(409);
  });

  test("scope extraction returns a draft", async () => {
    const created = (await call("POST", "/api/projects", newProject())).body;
    const result = await call("POST", `/api/projects/${created.project.id}/scope/extract`, undefined, created.freelancerToken);
    expect(result.body.items[0].text).toBe("Landing page");
  });

  test("the running total follows requests and reviews", async () => {
    const s = await setup();
    await call("POST", `/api/projects/${s.id}/requests`, { text: "Fix the page" }, s.token);
    const logo = (await call("POST", `/api/projects/${s.id}/requests`, { text: "Design a logo" }, s.token)).body;

    let view = (await call("GET", `/api/projects/${s.id}`, undefined, s.token)).body;
    expect(view.summary.unbilled).toEqual({ requestCount: 1, minutes: 120, amountCents: 20_000 });
    expect(view.summary.estimatedRequestCount).toBe(1);

    await call("PATCH", `/api/projects/${s.id}/requests/${logo.id}`, { minutes: 60 }, s.token);
    view = (await call("GET", `/api/projects/${s.id}`, undefined, s.token)).body;
    expect(view.summary.unbilled.amountCents).toBe(10_000);
    expect(view.summary.estimatedRequestCount).toBe(0);
  });

  test("a failed AI check is saved for review, not billed", async () => {
    const s = await setup();
    model.failing = true;
    const result = await call("POST", `/api/projects/${s.id}/requests`, { text: "Design a logo" }, s.token);
    expect(result.status).toBe(201);
    expect(result.body.label).toBe("needs_clarifying");
  });

  test("a request needs a time before billing", async () => {
    const s = await setup();
    const logo = (await call("POST", `/api/projects/${s.id}/requests`, { text: "Design a logo" }, s.token)).body;
    await call("PATCH", `/api/projects/${s.id}/requests/${logo.id}`, { minutes: 0 }, s.token);
    const result = await call("POST", `/api/projects/${s.id}/orders`, { requestIds: [logo.id] }, s.token);
    expect(result.status).toBe(409);
  });

  test("money in an open change order stays visible", async () => {
    const s = await setup();
    await approvedOrder(s);
    const { summary } = (await call("GET", `/api/projects/${s.id}`, undefined, s.token)).body;
    expect(summary.unbilled.amountCents).toBe(0);
    expect(summary.inChangeOrdersCents).toBe(20_000);
  });

  test("a request can't be billed twice", async () => {
    const s = await setup();
    const { requestId } = await approvedOrder(s);
    const result = await call("POST", `/api/projects/${s.id}/orders`, { requestIds: [requestId] }, s.token);
    expect(result.status).toBe(409);
  });

  test("deleting a draft frees its requests", async () => {
    const s = await setup();
    const logo = (await call("POST", `/api/projects/${s.id}/requests`, { text: "Design a logo" }, s.token)).body;
    const order = (await call("POST", `/api/projects/${s.id}/orders`, { requestIds: [logo.id] }, s.token)).body;
    await call("DELETE", `/api/projects/${s.id}/orders/${order.order.id}`, undefined, s.token);
    const view = (await call("GET", `/api/projects/${s.id}`, undefined, s.token)).body;
    expect(view.summary.unbilled.requestCount).toBe(1);
  });
});

describe("approval and client choice", () => {
  test("the client can't answer a draft", async () => {
    const s = await setup();
    const logo = (await call("POST", `/api/projects/${s.id}/requests`, { text: "Design a logo" }, s.token)).body;
    const order = (await call("POST", `/api/projects/${s.id}/orders`, { requestIds: [logo.id] }, s.token)).body;
    const result = await call("POST", `/api/client/${s.client}/orders/${order.order.id}/choices`, {
      choices: { [logo.id]: { type: "pay" } },
    });
    expect(result.status).toBe(409);
    expect(payments.created).toHaveLength(0);
  });

  test("editing after approval needs a new approval", async () => {
    const s = await setup();
    const { requestId, orderId } = await approvedOrder(s);
    await call("PATCH", `/api/projects/${s.id}/orders/${orderId}`, { lines: [{ requestId, amountCents: 30_000 }] }, s.token);
    const result = await call("POST", `/api/client/${s.client}/orders/${orderId}/choices`, {
      choices: { [requestId]: { type: "pay" } },
    });
    expect(result.status).toBe(409);
  });

  test("defer needs no payment and removes it from the total", async () => {
    const s = await setup();
    const { requestId, orderId } = await approvedOrder(s);
    const result = await call("POST", `/api/client/${s.client}/orders/${orderId}/choices`, {
      choices: { [requestId]: { type: "defer" } },
    });
    expect(result.body.orders[0].status).toBe("complete");
    expect(result.body.project.later).toHaveLength(1);
    expect(payments.created).toHaveLength(0);
    expect((await call("POST", `/api/client/${s.client}/orders/${orderId}/invoice`)).status).toBe(409);
  });

  test("a client from another project can't answer this order", async () => {
    const a = await setup();
    const b = await setup();
    const { requestId, orderId } = await approvedOrder(a);
    const result = await call("POST", `/api/client/${b.client}/orders/${orderId}/choices`, {
      choices: { [requestId]: { type: "pay" } },
    });
    expect(result.status).toBe(404);
  });

  test("one item can't be swapped out of two open change orders", async () => {
    const s = await setup();
    const faq = (await call("GET", `/api/client/${s.client}`)).body.project.scope[1].id;
    const first = await approvedOrder(s);
    const second = await approvedOrder(s);
    const swap = { type: "swap", removedScopeItemId: faq };
    expect(
      (await call("POST", `/api/client/${s.client}/orders/${first.orderId}/choices`, { choices: { [first.requestId]: swap } })).status,
    ).toBe(200);
    const result = await call("POST", `/api/client/${s.client}/orders/${second.orderId}/choices`, {
      choices: { [second.requestId]: swap },
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("already being swapped");
  });
});

describe("payment", () => {
  async function awaitingPayment(type: "pay" | "swap" = "pay") {
    const s = await setup();
    const faq = (await call("GET", `/api/client/${s.client}`)).body.project.scope[1].id;
    const { requestId, orderId } = await approvedOrder(s);
    const choice = type === "pay" ? { type } : { type, removedScopeItemId: faq };
    await call("POST", `/api/client/${s.client}/orders/${orderId}/choices`, { choices: { [requestId]: choice } });
    return { ...s, requestId, orderId, faq };
  }

  test("a paid invoice completes the order and updates the scope", async () => {
    const s = await awaitingPayment();
    const invoiced = await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    expect(invoiced.body.orders[0].invoiceStatus).toBe("SENT");
    expect(invoiced.body.orders[0].payerViewUrl).toContain("INV-1");
    expect(payments.created[0]?.input.items[0]?.unitAmount).toBe("200.00");

    let refreshed = await call("POST", `/api/client/${s.client}/orders/${s.orderId}/refresh`);
    expect(refreshed.body.orders[0].paid).toBe(false);
    expect(refreshed.body.project.scope).toHaveLength(2);

    payments.pay("INV-1");
    refreshed = await call("POST", `/api/client/${s.client}/orders/${s.orderId}/refresh`);
    expect(refreshed.body.orders[0].paid).toBe(true);
    expect(refreshed.body.project.scope).toHaveLength(3);

    const view = (await call("GET", `/api/projects/${s.id}`, undefined, s.token)).body;
    expect(view.summary.paidCents).toBe(20_000);
    expect(view.summary.awaitingPaymentCents).toBe(0);
    expect(view.project.amendments[0]).toContain("Design a new logo");
    expect(view.events.map((e: { type: string }) => e.type)).toContain("payment_confirmed");
  });

  test("a swap invoices only the difference and removes the item once paid", async () => {
    const s = await awaitingPayment("swap");
    await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    expect(payments.created[0]?.input.items[0]?.unitAmount).toBe("150.00");
    payments.pay("INV-1");
    const { body } = await call("POST", `/api/client/${s.client}/orders/${s.orderId}/refresh`);
    expect(body.project.scope.some((i: { id: string }) => i.id === s.faq)).toBe(false);
  });

  test("a manually marked invoice doesn't count", async () => {
    const s = await awaitingPayment();
    await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    payments.pay("INV-1", "MARKED_AS_PAID");
    const { body } = await call("POST", `/api/client/${s.client}/orders/${s.orderId}/refresh`);
    expect(body.orders[0].paid).toBe(false);
    expect(body.project.scope).toHaveLength(2);
  });

  test("asking twice creates one invoice", async () => {
    const s = await awaitingPayment();
    await Promise.all([
      call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`),
      call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`),
    ]);
    await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    expect(payments.created).toHaveLength(1);
  });

  test("a mismatched PayPal total is never sent", async () => {
    const s = await awaitingPayment();
    payments.totalOverride = "1.00";
    const result = await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    expect(result.status).toBe(502);
    expect(payments.invoices.get("INV-1")?.status).toBe("DRAFT");
  });

  test("a PayPal failure can be retried and hides details", async () => {
    const s = await awaitingPayment();
    payments.failCreate = true;
    const failed = await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    expect(failed.status).toBe(502);
    expect(failed.body.error).not.toContain("secret detail");

    payments.failCreate = false;
    const retried = await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    expect(retried.body.orders[0].invoiceStatus).toBe("SENT");
    expect(payments.created[0]?.requestId).toBe(`create-${s.orderId}`);
  });

  test("a verified PayPal webhook confirms payment with nobody on the page", async () => {
    const s = await awaitingPayment();
    await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    payments.pay("INV-1");

    const result = await webhook({ event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV-1" } } });
    expect(result.status).toBe(200);
    expect(result.body.handled).toBe(true);

    const view = (await call("GET", `/api/projects/${s.id}`, undefined, s.token)).body;
    expect(view.summary.paidCents).toBe(20_000);
    expect(view.events.map((e: { type: string }) => e.type)).toContain("webhook_received");
  });

  test("a webhook alone can't mark an invoice paid", async () => {
    const s = await awaitingPayment();
    await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);

    const result = await webhook({ event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV-1" } } });
    expect(result.status).toBe(200);
    const view = (await call("GET", `/api/projects/${s.id}`, undefined, s.token)).body;
    expect(view.summary.paidCents).toBe(0);
  });

  test("an unverified webhook is refused and changes nothing", async () => {
    const s = await awaitingPayment();
    await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    payments.pay("INV-1");
    webhookGenuine = false;

    const result = await webhook({ event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV-1" } } });
    expect(result.status).toBe(401);
    const view = (await call("GET", `/api/projects/${s.id}`, undefined, s.token)).body;
    expect(view.summary.paidCents).toBe(0);
  });

  test("webhooks are off unless a webhook ID is set, and unknown invoices are ignored", async () => {
    expect((await webhook({ event_type: "INVOICING.INVOICE.PAID" }, handler)).status).toBe(404);
    const unknown = await webhook({ event_type: "INVOICING.INVOICE.PAID", resource: { id: "INV-404" } });
    expect(unknown.body).toEqual({ received: true, handled: false });
  });

  test("a reminder goes through PayPal, at most once an hour", async () => {
    const s = await awaitingPayment();
    const early = await call("POST", `/api/projects/${s.id}/orders/${s.orderId}/remind`, undefined, s.token);
    expect(early.status).toBe(409);

    await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    const sent = await call("POST", `/api/projects/${s.id}/orders/${s.orderId}/remind`, undefined, s.token);
    expect(sent.status).toBe(200);
    expect(payments.reminded).toEqual(["INV-1"]);

    const again = await call("POST", `/api/projects/${s.id}/orders/${s.orderId}/remind`, undefined, s.token);
    expect(again.status).toBe(409);
    expect(payments.reminded).toHaveLength(1);
  });

  test("withdrawing cancels the PayPal invoice and frees the request", async () => {
    const s = await awaitingPayment();
    await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);

    const result = await call("POST", `/api/projects/${s.id}/orders/${s.orderId}/withdraw`, undefined, s.token);
    expect(result.status).toBe(200);
    expect(payments.cancelled).toEqual(["INV-1"]);

    const view = (await call("GET", `/api/projects/${s.id}`, undefined, s.token)).body;
    expect(view.orders).toHaveLength(0);
    expect(view.requests[0].billedInOrderId).toBeUndefined();
    expect(view.summary.unbilled.amountCents).toBe(20_000);
    expect(view.project.scope).toHaveLength(2);
  });

  test("a paid invoice can't be withdrawn, and the payment is recorded", async () => {
    const s = await awaitingPayment();
    await call("POST", `/api/client/${s.client}/orders/${s.orderId}/invoice`);
    payments.pay("INV-1");

    const result = await call("POST", `/api/projects/${s.id}/orders/${s.orderId}/withdraw`, undefined, s.token);
    expect(result.status).toBe(409);
    expect(payments.cancelled).toHaveLength(0);
    const view = (await call("GET", `/api/projects/${s.id}`, undefined, s.token)).body;
    expect(view.summary.paidCents).toBe(20_000);
  });

  test("only the freelancer can remind or withdraw", async () => {
    const s = await awaitingPayment();
    expect((await call("POST", `/api/projects/${s.id}/orders/${s.orderId}/withdraw`)).status).toBe(401);
    expect((await call("POST", `/api/projects/${s.id}/orders/${s.orderId}/remind`)).status).toBe(401);
  });
});

test("data survives in the database between lookups", async () => {
  const path = `${process.env.TEMP ?? "."}/scopebill-test-${crypto.randomUUID()}.db`;
  const first = new Store(path);
  const service = new ProjectService(first, new FakeModel(), new FakePayments(), () => {});
  const { project } = service.createProject(newProject());
  first.close();

  const second = new Store(path);
  expect(second.getProject(project.id)?.title).toBe("Lumen");
  second.close();
});
