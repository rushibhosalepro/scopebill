import type { ClientChoice } from "../core/change-order";
import { RuleError, type RequestLabel, type ScopeItemKind } from "../core/scope";
import { NotFound, UpstreamError, type ProjectService, type ScopeItemInput } from "./service";

const MAX_AGREEMENT = 30_000;
const MAX_TEXT = 4_000;
const MAX_RATE_CENTS = 100_000;
const MAX_MINUTES = 40 * 60;
const MAX_PRICE_CENTS = 10_000_000;

const KINDS: ScopeItemKind[] = ["deliverable", "limit", "exclusion"];
const LABELS: RequestLabel[] = ["in_scope", "out_of_scope", "needs_clarifying"];

export interface AppLimits {
  projectsPerHour: number;
  aiCallsPerDay: number;
}

/** Checks that a webhook call really came from PayPal. Left out when webhooks aren't set up. */
export type WebhookVerifier = (delivery: { headers: Headers; rawBody: string }) => Promise<boolean>;

class BadRequest extends Error {}
class Unauthorized extends Error {}
class TooMany extends Error {}

export function createHandler(
  service: ProjectService,
  limits: AppLimits = { projectsPerHour: 60, aiCallsPerDay: 500 },
  log: (message: string, error?: unknown) => void = console.error,
  demoClientEmail?: string,
  verifyWebhook?: WebhookVerifier,
) {
  const projectLimit = new WindowLimit(limits.projectsPerHour, 60 * 60 * 1000);
  const aiLimit = new WindowLimit(limits.aiCallsPerDay, 24 * 60 * 60 * 1000);

  const route = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = request.method;

    if (method === "GET" && pathname === "/api/health") return json({ ok: true });
    if (parts[0] !== "api") throw new NotFound("Not found");

    if (method === "POST" && pathname === "/api/paypal/webhook") {
      if (!verifyWebhook) throw new NotFound("Not found");
      const rawBody = await request.text();
      let verified = false;
      try {
        verified = await verifyWebhook({ headers: request.headers, rawBody });
      } catch (error) {
        // A 5xx makes PayPal retry later, which is what we want if the check itself failed.
        throw new UpstreamError("The webhook couldn't be verified right now", error);
      }
      if (!verified) throw new Unauthorized();

      let event: { event_type?: unknown; resource?: { id?: unknown; invoice?: { id?: unknown } } } | null;
      try {
        event = JSON.parse(rawBody);
      } catch {
        throw new BadRequest("Send a valid JSON body");
      }
      if (typeof event !== "object" || event === null) throw new BadRequest("Send a JSON object");
      const eventType = typeof event.event_type === "string" ? event.event_type : "";
      const invoiceId = event.resource?.invoice?.id ?? event.resource?.id;
      const handled =
        eventType.startsWith("INVOICING.INVOICE.") && typeof invoiceId === "string"
          ? await service.handleInvoiceWebhook(eventType, invoiceId)
          : false;
      return json({ received: true, handled });
    }

    if (method === "POST" && pathname === "/api/demo") {
      if (!demoClientEmail) throw new RuleError("The sample project isn't set up on this server");
      projectLimit.take("The demo has reached its hourly project limit. Try again later.");
      return json(service.createDemoProject(demoClientEmail), 201);
    }

    if (parts[1] === "projects") {
      if (method === "POST" && parts.length === 2) {
        projectLimit.take("The demo has reached its hourly project limit. Try again later.");
        const body = await readBody(request);
        const created = service.createProject({
          title: text(body, "title", 200),
          freelancerName: text(body, "freelancerName", 100),
          clientName: text(body, "clientName", 100),
          clientEmail: email(body, "clientEmail"),
          hourlyRateCents: whole(body, "hourlyRateCents", 1, MAX_RATE_CENTS),
          agreement: text(body, "agreement", MAX_AGREEMENT),
        });
        return json(created, 201);
      }

      const projectId = parts[2];
      if (!projectId) throw new NotFound("Not found");
      requireFreelancer(service, projectId, request);

      if (method === "GET" && parts.length === 3) return json(service.freelancerView(projectId));

      if (method === "POST" && parts[3] === "scope" && parts[4] === "extract" && parts.length === 5) {
        aiLimit.take(AI_LIMIT_MESSAGE);
        return json(await service.extractScopeDraft(projectId));
      }

      if (method === "PUT" && parts[3] === "scope" && parts.length === 4) {
        const body = await readBody(request);
        return json(service.confirmScope(projectId, scopeItems(body)));
      }

      if (parts[3] === "requests") {
        if (method === "POST" && parts.length === 4) {
          aiLimit.take(AI_LIMIT_MESSAGE);
          const body = await readBody(request);
          return json(await service.addRequest(projectId, text(body, "text", MAX_TEXT)), 201);
        }
        if (method === "PATCH" && parts.length === 5) {
          const body = await readBody(request);
          return json(
            service.reviewRequest(projectId, parts[4]!, {
              ...(body.label === undefined ? {} : { label: label(body.label) }),
              ...(body.minutes === undefined ? {} : { minutes: whole(body, "minutes", 0, MAX_MINUTES) }),
            }),
          );
        }
      }

      if (parts[3] === "orders") {
        const orderId = parts[4];
        if (method === "POST" && parts.length === 4) {
          aiLimit.take(AI_LIMIT_MESSAGE);
          const body = await readBody(request);
          return json(await service.createOrder(projectId, stringList(body, "requestIds", 50)), 201);
        }
        if (orderId && method === "PATCH" && parts.length === 5) {
          const body = await readBody(request);
          return json(service.editOrder(projectId, orderId, orderEdits(body)));
        }
        if (orderId && method === "DELETE" && parts.length === 5) {
          service.deleteDraft(projectId, orderId);
          return json({ deleted: true });
        }
        if (orderId && method === "POST" && parts[5] === "approve" && parts.length === 6) {
          return json(service.approveOrder(projectId, orderId));
        }
        if (orderId && method === "POST" && parts[5] === "refresh" && parts.length === 6) {
          return json(await service.refreshPayment(projectId, orderId));
        }
        if (orderId && method === "POST" && parts[5] === "remind" && parts.length === 6) {
          return json(await service.sendReminder(projectId, orderId));
        }
        if (orderId && method === "POST" && parts[5] === "withdraw" && parts.length === 6) {
          return json(await service.withdrawOrder(projectId, orderId));
        }
      }
    }

    if (parts[1] === "client" && parts[2]) {
      const token = parts[2];
      if (method === "GET" && parts.length === 3) return json(service.clientView(token));

      if (parts[3] === "orders" && parts[4] && method === "POST" && parts.length === 6) {
        const projectId = service.clientProjectId(token);
        const orderId = parts[4];
        if (parts[5] === "choices") {
          const body = await readBody(request);
          await service.submitChoices(projectId, orderId, choices(body));
          return json(service.clientView(token));
        }
        if (parts[5] === "invoice") {
          await service.ensureInvoice(projectId, orderId);
          return json(service.clientView(token));
        }
        if (parts[5] === "refresh") {
          await service.refreshPayment(projectId, orderId);
          return json(service.clientView(token));
        }
      }
    }

    throw new NotFound("Not found");
  };

  return async (request: Request): Promise<Response> => {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof BadRequest) return failure(error.message, 400);
      if (error instanceof Unauthorized) return failure("You don't have access to this project", 401);
      if (error instanceof NotFound) return failure(error.message, 404);
      if (error instanceof RuleError) return failure(error.message, 409);
      if (error instanceof TooMany) return failure(error.message, 429);
      if (error instanceof UpstreamError) return failure(error.message, 502);
      log("Unexpected server error", error);
      return failure("Something went wrong", 500);
    }
  };
}

const AI_LIMIT_MESSAGE = "The demo has reached its daily AI limit. Try again tomorrow.";

class WindowLimit {
  private count = 0;
  private resetAt = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  take(message: string): void {
    const now = Date.now();
    if (now >= this.resetAt) {
      this.count = 0;
      this.resetAt = now + this.windowMs;
    }
    if (this.count >= this.max) throw new TooMany(message);
    this.count++;
  }
}

function requireFreelancer(service: ProjectService, projectId: string, request: Request): void {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !service.isFreelancer(projectId, token)) throw new Unauthorized();
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BadRequest("Send a valid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("Send a JSON object");
  }
  return body as Record<string, unknown>;
}

function text(body: Record<string, unknown>, name: string, max: number): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) throw new BadRequest(`${name} is required`);
  if (value.length > max) throw new BadRequest(`${name} is too long`);
  return value.trim();
}

function email(body: Record<string, unknown>, name: string): string {
  const value = text(body, name, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new BadRequest(`${name} must be an email address`);
  return value;
}

function whole(body: Record<string, unknown>, name: string, min: number, max: number): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequest(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function label(value: unknown): RequestLabel {
  if (!LABELS.includes(value as RequestLabel)) throw new BadRequest("label isn't valid");
  return value as RequestLabel;
}

function stringList(body: Record<string, unknown>, name: string, max: number): string[] {
  const value = body[name];
  if (!Array.isArray(value) || value.length === 0 || value.length > max || value.some((v) => typeof v !== "string")) {
    throw new BadRequest(`${name} must be a list of 1 to ${max} ids`);
  }
  return value as string[];
}

function scopeItems(body: Record<string, unknown>): ScopeItemInput[] {
  const items = body.items;
  if (!Array.isArray(items) || items.length > 100) throw new BadRequest("items must be a list of up to 100");
  return items.map((raw) => {
    if (typeof raw !== "object" || raw === null) throw new BadRequest("Each item must be an object");
    const item = raw as Record<string, unknown>;
    if (!KINDS.includes(item.kind as ScopeItemKind)) throw new BadRequest("Item kind isn't valid");
    const sourceQuote = item.sourceQuote ?? "";
    if (typeof sourceQuote !== "string" || sourceQuote.length > MAX_TEXT) throw new BadRequest("sourceQuote isn't valid");
    return {
      kind: item.kind as ScopeItemKind,
      text: text(item, "text", 500),
      sourceQuote,
      ...(item.priceCents === undefined || item.priceCents === null
        ? {}
        : { priceCents: whole(item, "priceCents", 0, MAX_PRICE_CENTS) }),
    };
  });
}

function orderEdits(body: Record<string, unknown>) {
  const edits: Parameters<ProjectService["editOrder"]>[2] = {};
  if (body.message !== undefined) edits.message = text(body, "message", MAX_TEXT);
  if (body.lines !== undefined) {
    if (!Array.isArray(body.lines) || body.lines.length > 50) throw new BadRequest("lines must be a list");
    edits.lines = body.lines.map((raw) => {
      if (typeof raw !== "object" || raw === null) throw new BadRequest("Each line must be an object");
      const line = raw as Record<string, unknown>;
      return {
        requestId: text(line, "requestId", 100),
        ...(line.description === undefined ? {} : { description: text(line, "description", 500) }),
        ...(line.minutes === undefined ? {} : { minutes: whole(line, "minutes", 1, MAX_MINUTES) }),
        ...(line.amountCents === undefined ? {} : { amountCents: whole(line, "amountCents", 1, MAX_PRICE_CENTS) }),
      };
    });
  }
  return edits;
}

function choices(body: Record<string, unknown>): Record<string, ClientChoice> {
  const raw = body.choices;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BadRequest("choices must be an object");

  const parsed: Record<string, ClientChoice> = {};
  for (const [requestId, value] of Object.entries(raw)) {
    const choice = value as { type?: unknown; removedScopeItemId?: unknown } | null;
    if (choice?.type === "pay" || choice?.type === "defer") parsed[requestId] = { type: choice.type };
    else if (choice?.type === "swap" && typeof choice.removedScopeItemId === "string") {
      parsed[requestId] = { type: "swap", removedScopeItemId: choice.removedScopeItemId };
    } else throw new BadRequest("Each choice must be pay, swap or defer");
  }
  return parsed;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function failure(message: string, status: number): Response {
  return json({ error: message }, status);
}
