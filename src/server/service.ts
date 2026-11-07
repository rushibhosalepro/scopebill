import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  applyClientChoices,
  approve,
  attachInvoice,
  confirmPayment,
  draftChangeOrder,
  editDraft,
  formatCents,
  invoiceItems,
  scopeUpdate,
  toCents,
  type ChangeOrderLine,
  type ClientChoice,
} from "../core/change-order";
import { RuleError, priceForMinutes, unbilledTotal, type RequestLabel, type ScopeItem } from "../core/scope";
import type { JsonModel } from "../ai/openrouter";
import { classifyRequest, draftClientMessage, extractScope } from "../ai/scope-ai";
import type { InvoiceState, NewInvoice } from "../paypal/client";
import { DEMO_AGREEMENT, DEMO_REQUESTS, DEMO_SCOPE } from "./demo";
import type { Project, ProjectEvent, Store, StoredOrder, StoredRequest } from "./store";

export interface Payments {
  createDraftInvoice(input: NewInvoice, requestId: string): Promise<InvoiceState>;
  sendInvoice(invoiceId: string, requestId: string): Promise<void>;
  getInvoice(invoiceId: string): Promise<InvoiceState>;
}

export class NotFound extends Error {}

export class UpstreamError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
  }
}

export interface NewProjectInput {
  title: string;
  freelancerName: string;
  clientName: string;
  clientEmail: string;
  hourlyRateCents: number;
  agreement: string;
}

export interface ScopeItemInput {
  kind: ScopeItem["kind"];
  text: string;
  sourceQuote: string;
  priceCents?: number;
}

export class ProjectService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly model: JsonModel,
    private readonly payments: Payments,
    private readonly log: (message: string, error?: unknown) => void = console.error,
  ) {}

  createProject(input: NewProjectInput) {
    if (!input.clientEmail.toLowerCase().endsWith(".example.com")) {
      throw new RuleError("ScopeBill runs in the PayPal sandbox, so the client email must be a sandbox test account");
    }
    const project: Project = {
      id: crypto.randomUUID(),
      ...input,
      currency: "USD",
      scope: [],
      scopeConfirmed: false,
      amendments: [],
      later: [],
      createdAt: new Date().toISOString(),
    };
    const freelancerToken = randomBytes(24).toString("base64url");
    const clientToken = randomBytes(24).toString("base64url");

    this.store.transaction(() => {
      this.store.insertProject(project, hashToken(freelancerToken), clientToken);
      this.event(project.id, "freelancer", "project_created", { title: project.title });
    });
    return { project, freelancerToken, clientToken };
  }

  createDemoProject(clientEmail: string) {
    const created = this.createProject({
      title: "Lumen Coffee landing page",
      freelancerName: "Asha",
      clientName: "Lumen Coffee",
      clientEmail,
      hourlyRateCents: 10_000,
      agreement: DEMO_AGREEMENT,
    });
    const projectId = created.project.id;
    const started = Date.now();

    this.store.transaction(() => {
      this.confirmScope(projectId, DEMO_SCOPE);
      DEMO_REQUESTS.forEach((request, index) => {
        this.store.saveRequest({
          id: crypto.randomUUID(),
          projectId,
          receivedAt: new Date(started - (DEMO_REQUESTS.length - index) * 86_400_000).toISOString(),
          suggestedMinutes: request.minutes || null,
          injectionSuspected: false,
          rejectedQuotes: [],
          downgraded: false,
          reviewed: true,
          ...request,
        });
      });
    });
    return created;
  }

  isFreelancer(projectId: string, token: string): boolean {
    const expected = this.store.freelancerTokenHash(projectId);
    if (!expected) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(hashToken(token)));
  }

  async extractScopeDraft(projectId: string) {
    const project = this.project(projectId);
    if (project.scopeConfirmed) throw new RuleError("The scope is already confirmed");

    const result = await this.upstream("The AI couldn't read the agreement. Try again.", () =>
      extractScope(this.model, project.agreement),
    );
    this.event(projectId, "ai", "scope_extracted", {
      items: result.items.length,
      rejected: result.rejected.length,
    });
    return { items: result.items, rejected: result.rejected };
  }

  confirmScope(projectId: string, items: ScopeItemInput[]) {
    const project = this.project(projectId);
    if (this.store.listRequests(projectId).length > 0) {
      throw new RuleError("The scope can't be replaced once requests have been added");
    }
    if (items.length === 0) throw new RuleError("Add at least one scope item");

    project.scope = items.map((item) => ({ id: crypto.randomUUID(), ...item }));
    project.scopeConfirmed = true;
    this.store.transaction(() => {
      this.store.saveProject(project);
      this.event(projectId, "freelancer", "scope_confirmed", { items: items.length });
    });
    return project;
  }

  async addRequest(projectId: string, text: string): Promise<StoredRequest> {
    const project = this.project(projectId);
    if (!project.scopeConfirmed) throw new RuleError("Confirm the scope before adding requests");

    const request: StoredRequest = {
      id: crypto.randomUUID(),
      projectId,
      text,
      receivedAt: new Date().toISOString(),
      label: "needs_clarifying",
      citedQuotes: [],
      minutes: 0,
      reason: "The AI check was unavailable, so this needs your review.",
      suggestedMinutes: null,
      injectionSuspected: false,
      rejectedQuotes: [],
      downgraded: false,
      reviewed: false,
    };

    try {
      const { classification: c } = await classifyRequest(this.model, effectiveAgreement(project), text);
      Object.assign(request, {
        label: c.label,
        citedQuotes: c.citedQuotes,
        minutes: c.suggestedMinutes ?? 0,
        reason: c.reason,
        suggestedMinutes: c.suggestedMinutes,
        injectionSuspected: c.injectionSuspected,
        rejectedQuotes: c.rejectedQuotes,
        downgraded: c.downgraded,
      });
    } catch (error) {
      this.log("Request classification failed", error);
    }

    this.store.transaction(() => {
      this.store.saveRequest(request);
      this.event(projectId, "ai", "request_labeled", {
        requestId: request.id,
        label: request.label,
        injectionSuspected: request.injectionSuspected,
        downgraded: request.downgraded,
      });
    });
    return request;
  }

  reviewRequest(projectId: string, requestId: string, changes: { label?: RequestLabel; minutes?: number }) {
    const request = this.store.getRequest(projectId, requestId);
    if (!request) throw new NotFound("Request not found");
    if (request.billedInOrderId) throw new RuleError("This request is already in a change order");

    if (changes.label !== undefined) request.label = changes.label;
    if (changes.minutes !== undefined) request.minutes = changes.minutes;
    request.reviewed = true;

    this.store.transaction(() => {
      this.store.saveRequest(request);
      this.event(projectId, "freelancer", "request_reviewed", { requestId, ...changes });
    });
    return request;
  }

  async createOrder(projectId: string, requestIds: string[]): Promise<StoredOrder> {
    const project = this.project(projectId);
    const requests = [...new Set(requestIds)].map((id) => {
      const request = this.store.getRequest(projectId, id);
      if (!request) throw new NotFound("Request not found");
      if (request.minutes <= 0) throw new RuleError("Set the time for every request first");
      return request;
    });

    const fallback =
      `Hi ${project.clientName}, the items below fall outside our original agreement. ` +
      "You can add them, swap out another agreed item, or leave them for later. Whatever works best for you is fine.";
    let message = fallback;
    try {
      const drafted = await draftClientMessage(this.model, {
        freelancerName: project.freelancerName,
        clientName: project.clientName,
        extras: requests.map((r) => r.text),
      });
      message = drafted.message;
    } catch (error) {
      this.log("Change order drafting failed, using the standard message", error);
    }

    const order = draftChangeOrder({
      id: crypto.randomUUID(),
      currency: project.currency,
      hourlyRateCents: project.hourlyRateCents,
      message,
      requests,
    });
    const stored: StoredOrder = { projectId, createdAt: new Date().toISOString(), order };

    this.store.transaction(() => {
      this.store.saveOrder(stored);
      for (const request of requests) {
        this.store.saveRequest({ ...request, billedInOrderId: order.id });
      }
      this.event(projectId, "freelancer", "change_order_drafted", { orderId: order.id, lines: order.lines.length });
    });
    return stored;
  }

  editOrder(
    projectId: string,
    orderId: string,
    edits: { message?: string; lines?: Array<{ requestId: string; description?: string; minutes?: number; amountCents?: number }> },
  ): StoredOrder {
    const project = this.project(projectId);
    const stored = this.order(projectId, orderId);

    let lines: ChangeOrderLine[] | undefined;
    if (edits.lines) {
      const updates = new Map(edits.lines.map((line) => [line.requestId, line]));
      if (updates.size !== edits.lines.length || edits.lines.some((l) => !stored.order.lines.some((x) => x.requestId === l.requestId))) {
        throw new RuleError("Edits must match the requests in this change order");
      }
      lines = stored.order.lines.map((line) => {
        const update = updates.get(line.requestId);
        if (!update) return line;
        const minutes = update.minutes ?? line.minutes;
        const amountCents =
          update.amountCents ??
          (update.minutes !== undefined ? priceForMinutes(minutes, project.hourlyRateCents) : line.amountCents);
        if (minutes <= 0 || amountCents <= 0) throw new RuleError("Time and price must be more than zero");
        return { ...line, description: update.description ?? line.description, minutes, amountCents };
      });
    }

    const next: StoredOrder = {
      ...stored,
      order: editDraft(stored.order, {
        ...(edits.message === undefined ? {} : { message: edits.message }),
        ...(lines ? { lines } : {}),
      }),
    };
    this.store.transaction(() => {
      this.store.saveOrder(next);
      this.event(projectId, "freelancer", "change_order_edited", { orderId, version: next.order.version });
    });
    return next;
  }

  approveOrder(projectId: string, orderId: string): StoredOrder {
    const stored = this.order(projectId, orderId);
    const next = { ...stored, order: approve(stored.order) };
    this.store.transaction(() => {
      this.store.saveOrder(next);
      this.event(projectId, "freelancer", "change_order_approved", {
        orderId,
        version: next.order.version,
        hash: next.order.approvedHash,
      });
    });
    return next;
  }

  deleteDraft(projectId: string, orderId: string): void {
    const stored = this.order(projectId, orderId);
    if (stored.order.status !== "draft" && stored.order.status !== "approved") {
      throw new RuleError("Only a change order the client hasn't answered can be deleted");
    }
    this.store.transaction(() => {
      for (const line of stored.order.lines) {
        const request = this.store.getRequest(projectId, line.requestId);
        if (request) {
          const { billedInOrderId: _removed, ...rest } = request;
          this.store.saveRequest(rest);
        }
      }
      this.store.deleteOrder(projectId, orderId);
      this.event(projectId, "freelancer", "change_order_deleted", { orderId });
    });
  }

  submitChoices(projectId: string, orderId: string, choices: Record<string, ClientChoice>): Promise<StoredOrder> {
    return this.withLock(orderId, async () => {
      const project = this.project(projectId);
      const stored = this.order(projectId, orderId);

      const reserved = new Set(
        this.store
          .listOrders(projectId)
          .filter((o) => o.order.id !== orderId && o.order.status === "awaiting_payment")
          .flatMap((o) => Object.values(o.order.choices ?? {}))
          .flatMap((c) => (c.type === "swap" ? [c.removedScopeItemId] : [])),
      );
      for (const choice of Object.values(choices)) {
        if (choice.type === "swap" && reserved.has(choice.removedScopeItemId)) {
          throw new RuleError("That item is already being swapped in another change order");
        }
      }

      const order = applyClientChoices(stored.order, choices, project.scope);
      const next: StoredOrder = { ...stored, order };

      this.store.transaction(() => {
        this.store.saveOrder(next);
        this.event(projectId, "client", "client_chose", {
          orderId,
          choices: Object.values(choices).map((c) => c.type),
          amountDueCents: order.amountDueCents,
        });
        if (order.status === "complete") this.applyToProject(project, next);
      });
      return next;
    });
  }

  ensureInvoice(projectId: string, orderId: string): Promise<StoredOrder> {
    return this.withLock(orderId, async () => {
      const project = this.project(projectId);
      let stored = this.order(projectId, orderId);
      const due = stored.order.amountDueCents;
      if (stored.order.status !== "awaiting_payment" || !due) throw new RuleError("No payment is due on this change order");

      if (!stored.order.invoiceId) {
        const draft = await this.upstream("PayPal couldn't create the invoice. Try again.", () =>
          this.payments.createDraftInvoice(
            {
              recipientEmail: project.clientEmail,
              currency: project.currency,
              note: `Change order for ${project.title}`.slice(0, 200),
              items: invoiceItems(stored.order, project.scope),
            },
            `create-${orderId}`,
          ),
        );
        if (toCents(draft.total) !== due) {
          this.log(`Invoice ${draft.id} total ${draft.total} doesn't match amount due ${formatCents(due)}`);
          throw new UpstreamError("PayPal's invoice total didn't match the change order, so it wasn't sent.", null);
        }
        stored = { ...stored, order: attachInvoice(stored.order, draft.id) };
        const invoiceId = draft.id;
        const saved = stored;
        this.store.transaction(() => {
          this.store.saveOrder(saved);
          this.event(projectId, "paypal", "invoice_created", { orderId, invoiceId });
        });
      }

      const invoiceId = stored.order.invoiceId!;
      let invoice = await this.upstream("PayPal couldn't load the invoice. Try again.", () =>
        this.payments.getInvoice(invoiceId),
      );
      if (invoice.status === "DRAFT") {
        await this.upstream("PayPal couldn't send the invoice. Try again.", () =>
          this.payments.sendInvoice(invoiceId, `send-${orderId}`),
        );
        invoice = await this.upstream("PayPal couldn't load the invoice. Try again.", () =>
          this.payments.getInvoice(invoiceId),
        );
        this.event(projectId, "paypal", "invoice_sent", { orderId, invoiceId, status: invoice.status });
      }

      const next: StoredOrder = {
        ...stored,
        invoiceStatus: invoice.status,
        ...(invoice.payerViewUrl ? { payerViewUrl: invoice.payerViewUrl } : {}),
      };
      this.store.saveOrder(next);
      return next;
    });
  }

  refreshPayment(projectId: string, orderId: string): Promise<StoredOrder> {
    return this.withLock(orderId, async () => {
      const project = this.project(projectId);
      const stored = this.order(projectId, orderId);
      const invoiceId = stored.order.invoiceId;
      if (stored.order.status !== "awaiting_payment" || !invoiceId) return stored;

      const invoice = await this.upstream("PayPal couldn't load the invoice. Try again.", () =>
        this.payments.getInvoice(invoiceId),
      );
      const updated: StoredOrder = {
        ...stored,
        invoiceStatus: invoice.status,
        ...(invoice.payerViewUrl ? { payerViewUrl: invoice.payerViewUrl } : {}),
      };

      if (invoice.status !== "PAID") {
        this.store.saveOrder(updated);
        return updated;
      }

      const next: StoredOrder = {
        ...updated,
        order: confirmPayment(stored.order, {
          invoiceId: invoice.id,
          status: invoice.status,
          paidAmount: invoice.paidAmount,
          transactionIds: invoice.transactionIds,
        }),
      };
      this.store.transaction(() => {
        this.store.saveOrder(next);
        this.event(projectId, "paypal", "payment_confirmed", {
          orderId,
          invoiceId,
          transactionId: next.order.paymentTransactionId,
          paidAmount: invoice.paidAmount,
        });
        this.applyToProject(project, next);
      });
      return next;
    });
  }

  freelancerView(projectId: string) {
    const project = this.project(projectId);
    const requests = this.store.listRequests(projectId);
    const orders = this.store.listOrders(projectId);
    const unbilled = unbilledTotal(requests, project.hourlyRateCents);

    return {
      project,
      clientToken: this.store.clientToken(projectId),
      requests,
      orders,
      summary: {
        unbilled,
        estimatedRequestCount: requests.filter(
          (r) => r.label === "out_of_scope" && !r.billedInOrderId && !r.reviewed,
        ).length,
        paidCents: orders.reduce((sum, o) => sum + (o.order.paymentTransactionId ? (o.order.amountDueCents ?? 0) : 0), 0),
        inChangeOrdersCents: orders.reduce(
          (sum, o) =>
            sum +
            (o.order.status === "draft" || o.order.status === "approved"
              ? o.order.lines.reduce((total, line) => total + line.amountCents, 0)
              : 0),
          0,
        ),
        awaitingPaymentCents: orders.reduce(
          (sum, o) => sum + (o.order.status === "awaiting_payment" ? (o.order.amountDueCents ?? 0) : 0),
          0,
        ),
        deferredCount: project.later.length,
      },
      events: this.store.listEvents(projectId),
    };
  }

  clientView(token: string) {
    const project = this.store.getProjectByClientToken(token);
    if (!project) throw new NotFound("Project not found");

    const orders = this.store
      .listOrders(project.id)
      .filter((o) => o.order.status !== "draft")
      .map((o) => ({
        id: o.order.id,
        status: o.order.status,
        message: o.order.message,
        currency: o.order.currency,
        lines: o.order.lines.map((l) => ({
          requestId: l.requestId,
          description: l.description,
          amountCents: l.amountCents,
        })),
        choices: o.order.choices ?? null,
        amountDueCents: o.order.amountDueCents ?? null,
        invoiceStatus: o.invoiceStatus ?? null,
        payerViewUrl: o.payerViewUrl ?? null,
        paid: Boolean(o.order.paymentTransactionId),
      }));

    return {
      project: {
        id: project.id,
        title: project.title,
        freelancerName: project.freelancerName,
        clientName: project.clientName,
        scope: project.scope.map((s) => ({
          id: s.id,
          kind: s.kind,
          text: s.text,
          sourceQuote: s.sourceQuote,
          ...(s.priceCents === undefined ? {} : { priceCents: s.priceCents }),
        })),
        later: project.later.map((l) => ({ description: l.description, amountCents: l.amountCents })),
      },
      includedRequests: this.store
        .listRequests(project.id)
        .filter((r) => r.label === "in_scope")
        .map((r) => ({ id: r.id, text: r.text, citedQuotes: r.citedQuotes })),
      orders,
    };
  }

  clientProjectId(token: string): string {
    const project = this.store.getProjectByClientToken(token);
    if (!project) throw new NotFound("Project not found");
    return project.id;
  }

  private applyToProject(project: Project, stored: StoredOrder): void {
    const update = scopeUpdate(stored.order);
    const removed = new Set(update.removedScopeItemIds);
    const removedText = project.scope.filter((s) => removed.has(s.id)).map((s) => s.text);

    const next: Project = {
      ...project,
      scope: [
        ...project.scope.filter((s) => !removed.has(s.id)),
        ...update.added.map(
          (line): ScopeItem => ({
            id: crypto.randomUUID(),
            kind: "deliverable",
            text: line.description,
            sourceQuote: `Change order ${stored.order.id}`,
            priceCents: line.amountCents,
          }),
        ),
      ],
      amendments: [
        ...project.amendments,
        ...update.added.map((line) => `Added by approved change order: ${line.description}`),
        ...removedText.map((text) => `Removed by approved change order: ${text}`),
      ],
      later: [...project.later, ...update.deferred],
    };
    this.store.saveProject(next);
    this.event(project.id, "system", "scope_updated", {
      orderId: stored.order.id,
      added: update.added.length,
      removed: update.removedScopeItemIds.length,
      deferred: update.deferred.length,
    });
  }

  private project(id: string): Project {
    const project = this.store.getProject(id);
    if (!project) throw new NotFound("Project not found");
    return project;
  }

  private order(projectId: string, id: string): StoredOrder {
    const stored = this.store.getOrder(projectId, id);
    if (!stored) throw new NotFound("Change order not found");
    return stored;
  }

  private event(projectId: string, actor: ProjectEvent["actor"], type: string, detail: Record<string, unknown>): void {
    this.store.addEvent(projectId, { at: new Date().toISOString(), actor, type, detail });
  }

  private async upstream<T>(message: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RuleError) throw error;
      this.log(message, error);
      throw new UpstreamError(message, error);
    }
  }

  private withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined).finally(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    this.locks.set(key, tail);
    return run;
  }
}

export function effectiveAgreement(project: Project): string {
  if (project.amendments.length === 0) return project.agreement;
  return `${project.agreement}\n\nApproved changes:\n${project.amendments.map((a) => `- ${a}`).join("\n")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
