export type Label = "in_scope" | "out_of_scope" | "needs_clarifying";
export type Kind = "deliverable" | "limit" | "exclusion";
export type Choice = { type: "pay" } | { type: "swap"; removedScopeItemId: string } | { type: "defer" };

export interface ScopeItem {
  id: string;
  kind: Kind;
  text: string;
  sourceQuote: string;
  priceCents?: number;
}

export interface RequestItem {
  id: string;
  text: string;
  receivedAt: string;
  label: Label;
  citedQuotes: string[];
  minutes: number;
  billedInOrderId?: string;
  reason: string;
  injectionSuspected: boolean;
  downgraded: boolean;
  reviewed: boolean;
}

export interface OrderLine {
  requestId: string;
  description: string;
  minutes: number;
  amountCents: number;
}

export interface StoredOrder {
  createdAt: string;
  invoiceStatus?: string;
  payerViewUrl?: string;
  order: {
    id: string;
    currency: string;
    message: string;
    lines: OrderLine[];
    status: "draft" | "approved" | "awaiting_payment" | "complete";
    version: number;
    choices?: Record<string, Choice>;
    amountDueCents?: number;
    chargesCents?: Record<string, number>;
    invoiceId?: string;
    paymentTransactionId?: string;
  };
}

export interface FreelancerView {
  project: {
    id: string;
    title: string;
    freelancerName: string;
    clientName: string;
    hourlyRateCents: number;
    agreement: string;
    scope: ScopeItem[];
    scopeConfirmed: boolean;
    later: OrderLine[];
  };
  clientToken: string;
  requests: RequestItem[];
  orders: StoredOrder[];
  summary: {
    unbilled: { requestCount: number; minutes: number; amountCents: number };
    estimatedRequestCount: number;
    paidCents: number;
    inChangeOrdersCents: number;
    awaitingPaymentCents: number;
    deferredCount: number;
  };
  events: Array<{ at: string; actor: string; type: string; detail: Record<string, unknown> }>;
}

export interface ClientOrder {
  id: string;
  status: "approved" | "awaiting_payment" | "complete";
  message: string;
  currency: string;
  lines: Array<{ requestId: string; description: string; amountCents: number }>;
  choices: Record<string, Choice> | null;
  amountDueCents: number | null;
  invoiceStatus: string | null;
  payerViewUrl: string | null;
  paid: boolean;
}

export interface ClientView {
  project: {
    id: string;
    title: string;
    freelancerName: string;
    clientName: string;
    scope: Array<Omit<ScopeItem, "sourceQuote"> & { sourceQuote: string }>;
    later: Array<{ description: string; amountCents: number }>;
  };
  includedRequests: Array<{ id: string; text: string; citedQuotes: string[] }>;
  orders: ClientOrder[];
}

export interface Created {
  project: { id: string };
  freelancerToken: string;
  clientToken: string;
}

export async function api<T>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(data?.error ?? "Something went wrong. Please try again.");
  return data as T;
}

export const money = (cents: number | null | undefined): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents ?? 0) / 100);

export const toCents = (value: string): number | null => {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole = "0", fraction = ""] = value.trim().split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};

export const duration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
};

export const safePayUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "www.sandbox.paypal.com" ? url : null;
  } catch {
    return null;
  }
};
