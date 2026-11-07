import { createHash } from "node:crypto";
import { assertWhole, priceForMinutes, RuleError, type ClientRequest, type ScopeItem } from "./scope";

export interface ChangeOrderLine {
  requestId: string;
  description: string;
  minutes: number;
  amountCents: number;
}

export type ClientChoice =
  | { type: "pay" }
  | { type: "swap"; removedScopeItemId: string }
  | { type: "defer" };

export type ChangeOrderStatus =
  | "draft"
  | "approved"
  | "awaiting_payment"
  | "complete";

export interface ChangeOrder {
  id: string;
  currency: string;
  message: string;
  lines: ChangeOrderLine[];
  status: ChangeOrderStatus;
  version: number;
  approvedHash?: string;
  choices?: Record<string, ClientChoice>;
  amountDueCents?: number;
  chargesCents?: Record<string, number>;
  invoiceId?: string;
  paymentTransactionId?: string;
}

export interface ScopeUpdate {
  added: ChangeOrderLine[];
  removedScopeItemIds: string[];
  deferred: ChangeOrderLine[];
}

export interface PaymentEvidence {
  invoiceId: string;
  status: string;
  paidAmount: string | null;
  transactionIds: string[];
}

export function draftChangeOrder(input: {
  id: string;
  currency: string;
  hourlyRateCents: number;
  message: string;
  requests: ClientRequest[];
}): ChangeOrder {
  if (input.requests.length === 0) throw new RuleError("A change order needs at least one request");

  const lines = input.requests.map((request) => {
    if (request.label !== "out_of_scope") {
      throw new RuleError(`Request ${request.id} is not marked out of scope`);
    }
    if (request.billedInOrderId) {
      throw new RuleError(`Request ${request.id} is already in a change order`);
    }
    return {
      requestId: request.id,
      description: request.text,
      minutes: request.minutes,
      amountCents: priceForMinutes(request.minutes, input.hourlyRateCents),
    };
  });

  return {
    id: input.id,
    currency: input.currency,
    message: input.message,
    lines,
    status: "draft",
    version: 1,
  };
}

export function editDraft(
  order: ChangeOrder,
  edits: { message?: string; lines?: ChangeOrderLine[] },
): ChangeOrder {
  if (order.status !== "draft" && order.status !== "approved") {
    throw new RuleError("This change order can no longer be edited");
  }
  for (const line of edits.lines ?? []) assertWhole(line.amountCents, "amountCents");

  const next: ChangeOrder = {
    ...order,
    message: edits.message ?? order.message,
    lines: edits.lines ?? order.lines,
    status: "draft",
    version: order.version + 1,
  };
  delete next.approvedHash;
  return next;
}

export function approve(order: ChangeOrder): ChangeOrder {
  if (order.status !== "draft") throw new RuleError("Only a draft can be approved");
  return { ...order, status: "approved", approvedHash: contentHash(order) };
}

export function applyClientChoices(
  order: ChangeOrder,
  choices: Record<string, ClientChoice>,
  scope: ScopeItem[],
): ChangeOrder {
  if (order.status !== "approved") throw new RuleError("The freelancer must approve this first");
  if (order.approvedHash !== contentHash(order)) {
    throw new RuleError("This change order changed after approval");
  }

  const removed = new Set<string>();
  const chargesCents: Record<string, number> = {};
  let amountDueCents = 0;

  for (const line of order.lines) {
    const choice = choices[line.requestId];
    if (!choice) throw new RuleError(`Choose an option for request ${line.requestId}`);

    chargesCents[line.requestId] = 0;
    if (choice.type === "pay") chargesCents[line.requestId] = line.amountCents;

    if (choice.type === "swap") {
      const item = scope.find((s) => s.id === choice.removedScopeItemId);
      if (!item) throw new RuleError("The item to swap out isn't in the agreed scope");
      if (item.kind !== "deliverable") throw new RuleError("Only a deliverable can be swapped out");
      if (item.priceCents === undefined) throw new RuleError("The item to swap out has no agreed price");
      if (removed.has(item.id)) throw new RuleError("The same item can't be swapped out twice");
      if (item.priceCents > line.amountCents) {
        throw new RuleError("The swapped-out item can't be worth more than the new work");
      }
      removed.add(item.id);
      chargesCents[line.requestId] = line.amountCents - item.priceCents;
    }
    amountDueCents += chargesCents[line.requestId] ?? 0;
  }

  return {
    ...order,
    choices,
    amountDueCents,
    chargesCents,
    status: amountDueCents > 0 ? "awaiting_payment" : "complete",
  };
}

export function attachInvoice(order: ChangeOrder, invoiceId: string): ChangeOrder {
  if (order.status !== "awaiting_payment") throw new RuleError("No payment is due on this change order");
  if (order.invoiceId) throw new RuleError("This change order already has an invoice");
  return { ...order, invoiceId };
}

export function confirmPayment(order: ChangeOrder, evidence: PaymentEvidence): ChangeOrder {
  if (order.status !== "awaiting_payment") throw new RuleError("No payment is due on this change order");
  if (!order.invoiceId || evidence.invoiceId !== order.invoiceId) {
    throw new RuleError("This payment is for a different invoice");
  }
  if (evidence.status !== "PAID") throw new RuleError(`Invoice is ${evidence.status}, not PAID`);

  const transactionId = evidence.transactionIds[0];
  if (!transactionId) throw new RuleError("PayPal returned no payment transaction");
  if (toCents(evidence.paidAmount) !== order.amountDueCents) {
    throw new RuleError("The paid amount doesn't match the amount due");
  }
  return { ...order, status: "complete", paymentTransactionId: transactionId };
}

export function scopeUpdate(order: ChangeOrder): ScopeUpdate {
  if (order.status !== "complete" || !order.choices) {
    throw new RuleError("The scope only changes once the change order is complete");
  }
  const update: ScopeUpdate = { added: [], removedScopeItemIds: [], deferred: [] };

  for (const line of order.lines) {
    const choice = order.choices[line.requestId];
    if (choice?.type === "defer") update.deferred.push(line);
    if (choice?.type === "pay") update.added.push(line);
    if (choice?.type === "swap") {
      update.added.push(line);
      update.removedScopeItemIds.push(choice.removedScopeItemId);
    }
  }
  return update;
}

export interface InvoiceItem {
  name: string;
  description?: string;
  quantity: number;
  unitAmount: string;
}

export function invoiceItems(order: ChangeOrder, scope: ScopeItem[]): InvoiceItem[] {
  if (!order.choices) throw new RuleError("The client hasn't chosen yet");
  const items: InvoiceItem[] = [];

  for (const line of order.lines) {
    const choice = order.choices[line.requestId];
    const name = line.description.replace(/\s+/g, " ").trim().slice(0, 120) || "Change order item";

    if (choice?.type === "pay" && line.amountCents > 0) {
      items.push({ name, quantity: 1, unitAmount: formatCents(line.amountCents) });
    }
    if (choice?.type === "swap") {
      const removed = scope.find((s) => s.id === choice.removedScopeItemId);
      const difference = line.amountCents - (removed?.priceCents ?? 0);
      if (difference > 0) {
        items.push({
          name,
          description: `Price difference after swapping out: ${removed?.text ?? "agreed item"}`.slice(0, 500),
          quantity: 1,
          unitAmount: formatCents(difference),
        });
      }
    }
  }
  return items;
}

export function formatCents(cents: number): string {
  assertWhole(cents, "cents");
  return (cents / 100).toFixed(2);
}

export function toCents(value: string | null): number | null {
  if (value === null || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function contentHash(order: ChangeOrder): string {
  return createHash("sha256")
    .update(JSON.stringify({ currency: order.currency, message: order.message, lines: order.lines }))
    .digest("hex");
}
