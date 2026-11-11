const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

export interface PayPalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  webhookId?: string;
}

export interface InvoiceNotice {
  subject: string;
  note: string;
}

/** The PayPal-* headers and the unmodified body of an incoming webhook call. */
export interface WebhookDelivery {
  headers: Headers;
  rawBody: string;
}

export interface InvoiceLine {
  name: string;
  description?: string;
  quantity: number;
  unitAmount: string;
}

export interface NewInvoice {
  recipientEmail: string;
  currency: string;
  note?: string;
  items: InvoiceLine[];
}

export interface InvoiceState {
  id: string;
  status: string;
  total: string | null;
  currency: string | null;
  paidAmount: string | null;
  payerViewUrl: string | null;
  transactionIds: string[];
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debugId: string | null,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): PayPalConfig {
  const baseUrl = env.PAYPAL_BASE_URL?.trim().replace(/\/$/, "");
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();

  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error("Set PAYPAL_BASE_URL, PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env");
  }
  if (baseUrl !== SANDBOX_BASE_URL) {
    throw new Error(`ScopeBill only runs against the PayPal sandbox (${SANDBOX_BASE_URL})`);
  }
  const webhookId = env.PAYPAL_WEBHOOK_ID?.trim();
  return { baseUrl, clientId, clientSecret, ...(webhookId ? { webhookId } : {}) };
}

export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: PayPalConfig) {}

  async createDraftInvoice(input: NewInvoice, requestId: string): Promise<InvoiceState> {
    const { invoice_number } = await this.request<{ invoice_number: string }>(
      "POST",
      "/v2/invoicing/generate-next-invoice-number",
    );

    const body = {
      detail: {
        invoice_number,
        currency_code: input.currency,
        ...(input.note ? { note: input.note } : {}),
      },
      primary_recipients: [{ billing_info: { email_address: input.recipientEmail } }],
      items: input.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
        quantity: String(item.quantity),
        unit_amount: { currency_code: input.currency, value: item.unitAmount },
        unit_of_measure: "QUANTITY",
      })),
    };

    const created = await this.request<RawInvoice>("POST", "/v2/invoicing/invoices", body, {
      Prefer: "return=representation",
      "PayPal-Request-Id": requestId,
    });
    return toInvoiceState(created);
  }

  async sendInvoice(invoiceId: string, requestId: string): Promise<void> {
    await this.request(
      "POST",
      `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`,
      { send_to_recipient: true, send_to_invoicer: false },
      { "PayPal-Request-Id": requestId },
    );
  }

  async getInvoice(invoiceId: string): Promise<InvoiceState> {
    const invoice = await this.request<RawInvoice>(
      "GET",
      `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`,
    );
    return toInvoiceState(invoice);
  }

  /** Asks PayPal to email the payer a reminder about a sent, unpaid invoice. */
  async remindInvoice(invoiceId: string, notice: InvoiceNotice): Promise<void> {
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/remind`, {
      subject: notice.subject,
      note: notice.note,
      send_to_recipient: true,
      send_to_invoicer: false,
    });
  }

  /** Cancels a sent invoice so it can no longer be paid, and tells the payer. */
  async cancelInvoice(invoiceId: string, notice: InvoiceNotice): Promise<void> {
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/cancel`, {
      subject: notice.subject,
      note: notice.note,
      send_to_recipient: true,
      send_to_invoicer: false,
    });
  }

  get webhooksEnabled(): boolean {
    return Boolean(this.config.webhookId);
  }

  /**
   * Asks PayPal whether a webhook call really came from PayPal for our webhook.
   * The event is spliced in as the raw text we received, because re-serializing
   * the JSON can change it enough to fail verification.
   */
  async verifyWebhook(delivery: WebhookDelivery): Promise<boolean> {
    const webhookId = this.config.webhookId;
    if (!webhookId) return false;

    const header = (name: string) => delivery.headers.get(name);
    const fields = {
      auth_algo: header("paypal-auth-algo"),
      cert_url: header("paypal-cert-url"),
      transmission_id: header("paypal-transmission-id"),
      transmission_sig: header("paypal-transmission-sig"),
      transmission_time: header("paypal-transmission-time"),
      webhook_id: webhookId,
    };
    if (Object.values(fields).some((value) => !value)) return false;
    if (safeJson(delivery.rawBody) === delivery.rawBody) return false;

    const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${delivery.rawBody}}`;
    const result = await this.request<{ verification_status?: string }>(
      "POST",
      "/v1/notifications/verify-webhook-signature",
      new RawJson(body),
    );
    return result?.verification_status === "SUCCESS";
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;

    const credentials = btoa(`${this.config.clientId}:${this.config.clientSecret}`);
    const response = await fetch(`${this.config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    const data = (await response.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; error_description?: string }
      | null;

    if (!response.ok || !data?.access_token) {
      throw new PayPalError(
        `PayPal sign-in failed: ${data?.error_description ?? response.statusText}`,
        response.status,
        response.headers.get("paypal-debug-id"),
        null,
      );
    }

    const lifetimeMs = (data.expires_in ?? 300) * 1000;
    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + Math.max(lifetimeMs - 60_000, 0),
    };
    return data.access_token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: body instanceof RawJson ? body.text : JSON.stringify(body) }),
    });

    const text = await response.text();
    const data: unknown = text ? safeJson(text) : null;

    if (!response.ok) {
      const error = data as { name?: string; message?: string; debug_id?: string; details?: unknown } | null;
      throw new PayPalError(
        `${method} ${path} failed: ${error?.name ?? response.status} ${error?.message ?? ""}`.trim(),
        response.status,
        error?.debug_id ?? response.headers.get("paypal-debug-id"),
        error?.details ?? data,
      );
    }
    return data as T;
  }
}

/** A request body that is already JSON text and must be sent as is. */
class RawJson {
  constructor(readonly text: string) {}
}

interface RawInvoice {
  id: string;
  status: string;
  detail?: {
    metadata?: { recipient_view_url?: string };
  };
  amount?: { value?: string; currency_code?: string };
  payments?: {
    paid_amount?: { value?: string };
    transactions?: Array<{ payment_id?: string }>;
  };
}

function toInvoiceState(invoice: RawInvoice): InvoiceState {
  return {
    id: invoice.id,
    status: invoice.status,
    total: invoice.amount?.value ?? null,
    currency: invoice.amount?.currency_code ?? null,
    paidAmount: invoice.payments?.paid_amount?.value ?? null,
    payerViewUrl: invoice.detail?.metadata?.recipient_view_url ?? null,
    transactionIds: (invoice.payments?.transactions ?? []).flatMap((t) =>
      t.payment_id ? [t.payment_id] : [],
    ),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
