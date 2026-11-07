import { describe, expect, test } from "bun:test";
import {
  applyClientChoices,
  approve,
  attachInvoice,
  confirmPayment,
  draftChangeOrder,
  editDraft,
  formatCents,
  scopeUpdate,
  type ChangeOrder,
  type PaymentEvidence,
} from "./change-order";
import { invalidCitations, unbilledTotal, type ClientRequest, type ScopeItem } from "./scope";

const RATE = 10_000;

const request = (id: string, minutes: number, extra: Partial<ClientRequest> = {}): ClientRequest => ({
  id,
  text: `Request ${id}`,
  receivedAt: "2026-11-07T10:00:00Z",
  label: "out_of_scope",
  citedQuotes: [],
  minutes,
  ...extra,
});

const scope: ScopeItem[] = [
  { id: "faq", kind: "deliverable", text: "FAQ page", sourceQuote: "FAQ page", priceCents: 5_000 },
  { id: "big", kind: "deliverable", text: "Blog", sourceQuote: "Blog", priceCents: 90_000 },
  { id: "free", kind: "deliverable", text: "Logo", sourceQuote: "Logo" },
  { id: "rev", kind: "limit", text: "3 revisions", sourceQuote: "3 revisions", priceCents: 1_000 },
];

const approvedOrder = (minutes = 120): ChangeOrder =>
  approve(
    draftChangeOrder({
      id: "co1",
      currency: "USD",
      hourlyRateCents: RATE,
      message: "Happy to add this.",
      requests: [request("r1", minutes)],
    }),
  );

const awaiting = (): ChangeOrder =>
  attachInvoice(applyClientChoices(approvedOrder(), { r1: { type: "pay" } }, scope), "INV-1");

const paid = (extra: Partial<PaymentEvidence> = {}): PaymentEvidence => ({
  invoiceId: "INV-1",
  status: "PAID",
  paidAmount: "200.00",
  transactionIds: ["TX1"],
  ...extra,
});

describe("running total", () => {
  test("adds only open out-of-scope requests", () => {
    const total = unbilledTotal(
      [
        request("a", 30),
        request("b", 90),
        request("c", 60, { label: "in_scope" }),
        request("d", 60, { label: "needs_clarifying" }),
        request("e", 60, { billedInOrderId: "co0" }),
      ],
      RATE,
    );
    expect(total).toEqual({ requestCount: 2, minutes: 120, amountCents: 20_000 });
  });
});

describe("citations", () => {
  const agreement = "The project includes a  landing page\nand 3 rounds of revisions.";

  test("accepts quotes found in the agreement despite spacing and case", () => {
    expect(invalidCitations(["LANDING PAGE and 3 rounds"], agreement)).toEqual([]);
  });

  test("rejects invented or empty quotes", () => {
    expect(invalidCitations(["unlimited revisions", "  "], agreement)).toEqual(["unlimited revisions", "  "]);
  });
});

describe("approval", () => {
  test("prices come from minutes and the rate", () => {
    expect(approvedOrder().lines[0]?.amountCents).toBe(20_000);
  });

  test("rejects requests that aren't billable", () => {
    const build = (r: ClientRequest) =>
      draftChangeOrder({ id: "x", currency: "USD", hourlyRateCents: RATE, message: "", requests: [r] });
    expect(() => build(request("a", 30, { label: "in_scope" }))).toThrow("not marked out of scope");
    expect(() => build(request("a", 30, { billedInOrderId: "co0" }))).toThrow("already");
  });

  test("the client can't choose before freelancer approval", () => {
    const draft = editDraft(approvedOrder(), { message: "Changed" });
    expect(draft.status).toBe("draft");
    expect(draft.approvedHash).toBeUndefined();
    expect(() => applyClientChoices(draft, { r1: { type: "pay" } }, scope)).toThrow("must approve");
  });

  test("a change after approval is rejected", () => {
    const tampered = { ...approvedOrder(), message: "Pay double" };
    expect(() => applyClientChoices(tampered, { r1: { type: "pay" } }, scope)).toThrow("changed after approval");
  });
});

describe("client choices", () => {
  test("pay charges the full line", () => {
    const order = applyClientChoices(approvedOrder(), { r1: { type: "pay" } }, scope);
    expect(order.amountDueCents).toBe(20_000);
    expect(order.status).toBe("awaiting_payment");
  });

  test("swap charges only the difference", () => {
    const order = applyClientChoices(approvedOrder(), { r1: { type: "swap", removedScopeItemId: "faq" } }, scope);
    expect(order.amountDueCents).toBe(15_000);
    expect(order.chargesCents).toEqual({ r1: 15_000 });
  });

  test("each line records what it actually charges", () => {
    const order = applyClientChoices(
      approve(
        draftChangeOrder({
          id: "co2",
          currency: "USD",
          hourlyRateCents: RATE,
          message: "Note",
          requests: [request("a", 60), request("b", 120), request("c", 180)],
        }),
      ),
      {
        a: { type: "pay" },
        b: { type: "swap", removedScopeItemId: "faq" },
        c: { type: "defer" },
      },
      scope,
    );
    expect(order.chargesCents).toEqual({ a: 10_000, b: 15_000, c: 0 });
    expect(order.amountDueCents).toBe(25_000);
  });

  test("defer completes with nothing due and no scope added", () => {
    const order = applyClientChoices(approvedOrder(), { r1: { type: "defer" } }, scope);
    expect(order.status).toBe("complete");
    expect(order.amountDueCents).toBe(0);
    expect(scopeUpdate(order)).toEqual({
      added: [],
      removedScopeItemIds: [],
      deferred: [order.lines[0]!],
    });
  });

  test("an even swap completes without an invoice", () => {
    const order = applyClientChoices(approvedOrder(30), { r1: { type: "swap", removedScopeItemId: "faq" } }, scope);
    expect(order.status).toBe("complete");
    expect(() => attachInvoice(order, "INV-1")).toThrow("No payment is due");
  });

  test("invalid swaps are rejected", () => {
    const swap = (id: string) =>
      applyClientChoices(approvedOrder(), { r1: { type: "swap", removedScopeItemId: id } }, scope);
    expect(() => swap("missing")).toThrow("isn't in the agreed scope");
    expect(() => swap("rev")).toThrow("Only a deliverable");
    expect(() => swap("free")).toThrow("no agreed price");
    expect(() => swap("big")).toThrow("worth more");
  });

  test("every line needs a choice", () => {
    expect(() => applyClientChoices(approvedOrder(), {}, scope)).toThrow("Choose an option");
  });
});

describe("payment confirmation", () => {
  test("completes only on matching PayPal evidence", () => {
    const order = confirmPayment(awaiting(), paid());
    expect(order.status).toBe("complete");
    expect(order.paymentTransactionId).toBe("TX1");
    expect(scopeUpdate(order).added).toHaveLength(1);
  });

  test.each([
    ["a different invoice", paid({ invoiceId: "INV-2" }), "different invoice"],
    ["a sent invoice", paid({ status: "SENT" }), "not PAID"],
    ["a manually marked invoice", paid({ status: "MARKED_AS_PAID" }), "not PAID"],
    ["a partial payment", paid({ status: "PARTIALLY_PAID", paidAmount: "50.00" }), "not PAID"],
    ["no transaction", paid({ transactionIds: [] }), "no payment transaction"],
    ["the wrong amount", paid({ paidAmount: "199.99" }), "doesn't match"],
    ["a missing amount", paid({ paidAmount: null }), "doesn't match"],
  ])("rejects %s", (_name, evidence, message) => {
    expect(() => confirmPayment(awaiting(), evidence)).toThrow(message);
  });

  test("accepts PayPal amounts without trailing zeros", () => {
    expect(confirmPayment(awaiting(), paid({ paidAmount: "200" })).status).toBe("complete");
    expect(confirmPayment(awaiting(), paid({ paidAmount: "200.0" })).status).toBe("complete");
  });

  test("scope doesn't change before payment", () => {
    expect(() => scopeUpdate(awaiting())).toThrow("only changes once");
  });

  test("a second invoice can't be attached", () => {
    expect(() => attachInvoice(awaiting(), "INV-2")).toThrow("already has an invoice");
  });
});

test("formats cents for PayPal", () => {
  expect(formatCents(15_005)).toBe("150.05");
  expect(() => formatCents(1.5)).toThrow("whole number");
});
