import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type GridApi,
  type ProcessCellForExportParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  api,
  duration,
  money,
  toCents,
  type FreelancerView,
  type Kind,
  type Label,
  type RequestItem,
  type StoredOrder,
} from "./api";

ModuleRegistry.registerModules([AllCommunityModule]);

const LABELS: Record<Label, string> = {
  in_scope: "In scope",
  out_of_scope: "Out of scope",
  needs_clarifying: "Needs clarifying",
};

const KINDS: Record<Kind, string> = { deliverable: "Deliverable", limit: "Limit", exclusion: "Not included" };

const EVENT_TEXT: Record<string, string> = {
  project_created: "Project created",
  scope_extracted: "AI read the agreement",
  scope_confirmed: "Freelancer confirmed the scope",
  request_labeled: "AI checked a client request",
  request_reviewed: "Freelancer reviewed a request",
  change_order_drafted: "Change order drafted",
  change_order_edited: "Change order edited",
  change_order_approved: "Freelancer approved the change order",
  change_order_deleted: "Draft deleted",
  client_chose: "Client made a choice",
  invoice_created: "PayPal invoice created",
  invoice_sent: "PayPal invoice sent",
  payment_confirmed: "PayPal confirmed payment",
  scope_updated: "Project scope updated",
  webhook_received: "PayPal sent a webhook",
  reminder_sent: "PayPal reminder sent to the client",
  invoice_cancelled: "PayPal invoice cancelled",
  change_order_withdrawn: "Change order withdrawn",
};

const ACTORS: Record<string, string> = {
  freelancer: "Freelancer",
  client: "Client",
  ai: "AI",
  paypal: "PayPal",
  system: "ScopeBill",
};

const CHECK_STEPS = [
  "Reading the request against your agreement...",
  "Looking for the clause that covers it...",
  "Estimating the time it would take...",
];

/** Cycles through progress messages while a slow step runs, so the wait never looks frozen. */
function useProgress(active: boolean, steps: string[]): string | null {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    setIndex(0);
    const timer = setInterval(() => setIndex((i) => Math.min(i + 1, steps.length - 1)), 3500);
    return () => clearInterval(timer);
  }, [active, steps]);
  return active ? (steps[index] ?? null) : null;
}

/** Exports what the grid shows (formatted money and times), not the raw cents. */
const exportCell = (params: ProcessCellForExportParams): string => {
  const shown = params.formatValue(params.value);
  return shown ?? String(params.value ?? "");
};

interface Props {
  projectId: string;
  token: string;
}

export function Dashboard({ projectId, token }: Props) {
  const [view, setView] = useState<FreelancerView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setView(await api<FreelancerView>("GET", `/api/projects/${projectId}`, { token }));
  }, [projectId, token]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  const awaiting = view?.orders.filter((o) => o.order.status === "awaiting_payment" && o.order.invoiceId) ?? [];
  const pollKey = awaiting.map((o) => o.order.id).join();

  useEffect(() => {
    if (!pollKey) return;
    const timer = setInterval(() => {
      void (async () => {
        await Promise.all(
          pollKey.split(",").map((id) => api("POST", `/api/projects/${projectId}/orders/${id}/refresh`, { token })),
        );
        await load();
      })().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [pollKey, projectId, token, load]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setError(null);
      try {
        await work();
        await load();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [load],
  );

  if (!view) {
    return (
      <main className="page">
        {error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading your project...</p>}
      </main>
    );
  }

  const base = `/api/projects/${projectId}`;
  const header = (
    <header className="topbar">
      <a className="brand" href="#/">ScopeBill</a>
      <span className="sandbox-tag">PayPal sandbox</span>
    </header>
  );

  if (!view.project.scopeConfirmed) {
    return (
      <>
        {header}
        <main className="page narrow">
          {error && <p className="error" role="alert">{error}</p>}
          <SetupScope view={view} base={base} token={token} run={run} />
        </main>
      </>
    );
  }

  return (
    <>
      {header}
      <main className="page">
        <div className="title-row">
          <div>
            <h1>{view.project.title}</h1>
            <p className="muted">
              For {view.project.clientName} · {money(view.project.hourlyRateCents)}/hour
            </p>
          </div>
          <ClientLink token={view.clientToken} />
        </div>

        {error && <p className="error" role="alert">{error}</p>}

        <Summary view={view} />

        <div className="columns">
          <Requests view={view} base={base} token={token} run={run} />
          <ScopeList view={view} />
        </div>

        <Orders view={view} base={base} token={token} run={run} />
        <Ledger orders={view.orders} />
        <Timeline view={view} />
      </main>
    </>
  );
}

function ClientLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}${location.pathname}#/c/${token}`;
  return (
    <div className="client-link">
      <a className="plain button-link" href={url} target="_blank" rel="noreferrer">
        Open client page
      </a>
      <button
        className="plain"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

function Summary({ view }: { view: FreelancerView }) {
  const { unbilled, estimatedRequestCount, paidCents, inChangeOrdersCents, awaitingPaymentCents, deferredCount } =
    view.summary;
  return (
    <section className="summary" aria-label="Project totals">
      <div className="summary-main">
        <p className="eyebrow">Unbilled so far</p>
        <p className="big-number">{money(unbilled.amountCents)}</p>
        <p>
          {unbilled.requestCount} {unbilled.requestCount === 1 ? "request" : "requests"} · {duration(unbilled.minutes)}
          {estimatedRequestCount > 0 && ` · ${estimatedRequestCount} still an AI estimate`}
        </p>
      </div>
      <dl className="summary-side">
        <div>
          <dt>In change orders</dt>
          <dd>{money(inChangeOrdersCents)}</dd>
        </div>
        <div>
          <dt>Paid</dt>
          <dd>{money(paidCents)}</dd>
        </div>
        <div>
          <dt>Awaiting payment</dt>
          <dd>{money(awaitingPaymentCents)}</dd>
        </div>
        <div>
          <dt>Left for later</dt>
          <dd>{deferredCount}</dd>
        </div>
      </dl>
    </section>
  );
}

interface SectionProps {
  view: FreelancerView;
  base: string;
  token: string;
  run: (work: () => Promise<unknown>) => Promise<void>;
}

function Requests({ view, base, token, run }: SectionProps) {
  const [text, setText] = useState("");
  const [working, setWorking] = useState<"check" | "order" | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [layout, setLayout] = useState<"cards" | "table">("cards");
  const busy = working !== null;
  const progress = useProgress(working === "check", CHECK_STEPS);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setWorking("check");
    await run(async () => {
      await api("POST", `${base}/requests`, { token, body: { text } });
      setText("");
    });
    setWorking(null);
  };

  const review = (id: string, changes: { label?: Label; minutes?: number }) =>
    run(() => api("PATCH", `${base}/requests/${id}`, { token, body: changes }));

  const billable = view.requests.filter((r) => r.label === "out_of_scope" && !r.billedInOrderId && r.minutes > 0);
  const chosen = billable.filter((r) => selected.has(r.id));
  const chosenMinutes = chosen.reduce((sum, r) => sum + r.minutes, 0);

  const prepare = async () => {
    setWorking("order");
    await run(async () => {
      await api("POST", `${base}/orders`, { token, body: { requestIds: chosen.map((r) => r.id) } });
      setSelected(new Set());
    });
    setWorking(null);
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Client requests</h2>
        <div className="segmented" role="group" aria-label="How to show requests">
          <button className={layout === "cards" ? "on" : ""} aria-pressed={layout === "cards"} onClick={() => setLayout("cards")}>
            Cards
          </button>
          <button className={layout === "table" ? "on" : ""} aria-pressed={layout === "table"} onClick={() => setLayout("table")}>
            Table
          </button>
        </div>
      </div>
      <form className="add-request" onSubmit={add}>
        <label htmlFor="new-request">Paste what the client asked</label>
        <textarea
          id="new-request"
          rows={2}
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Can you just add..."
        />
        <button className="primary" disabled={busy || !text.trim()}>
          {working === "check" ? "Checking..." : "Check request"}
        </button>
        <p className="muted small progress" role="status" aria-live="polite">
          {progress}
        </p>
      </form>

      {layout === "table" ? (
        <RequestGrid requests={view.requests} selected={selected} onSelect={setSelected} onChange={review} />
      ) : (
        <ul className="request-list">
          {[...view.requests].reverse().map((request) => (
            <RequestRow
              key={`${request.id}-${request.minutes}-${request.label}`}
              request={request}
              selected={selected.has(request.id)}
              onToggle={(on) => {
                const next = new Set(selected);
                if (on) next.add(request.id);
                else next.delete(request.id);
                setSelected(next);
              }}
              onChange={(changes) => review(request.id, changes)}
            />
          ))}
        </ul>
      )}

      {billable.length > 0 && (
        <div className="prepare-bar">
          <span>
            {chosen.length} selected · {money(Math.round((chosenMinutes * view.project.hourlyRateCents) / 60))}
          </span>
          <button
            className="plain"
            onClick={() => setSelected(new Set(chosen.length === billable.length ? [] : billable.map((r) => r.id)))}
          >
            {chosen.length === billable.length ? "Clear" : "Select all"}
          </button>
          <button className="primary" disabled={busy || chosen.length === 0} onClick={prepare}>
            {working === "order" ? "Drafting a polite note..." : "Prepare change order"}
          </button>
        </div>
      )}
    </section>
  );
}

const canBill = (request: RequestItem): boolean =>
  request.label === "out_of_scope" && !request.billedInOrderId && request.minutes > 0;

/**
 * The same requests as the cards, as an AG Grid for working through many at
 * once: edit the label and time in place, filter, and tick rows to bill.
 */
function RequestGrid({
  requests,
  selected,
  onSelect,
  onChange,
}: {
  requests: RequestItem[];
  selected: Set<string>;
  onSelect: (ids: Set<string>) => void;
  onChange: (id: string, changes: { label?: Label; minutes?: number }) => void;
}) {
  const rows = useMemo(() => [...requests].reverse(), [requests]);
  const apiRef = useRef<GridApi<RequestItem> | null>(null);
  const syncing = useRef(false);

  // Keep the grid's ticks in step with the selection shared with the card view.
  const syncSelection = useCallback(() => {
    const grid = apiRef.current;
    if (!grid) return;
    syncing.current = true;
    grid.forEachNode((node) => {
      const want = Boolean(node.data && selected.has(node.data.id) && canBill(node.data));
      if (node.isSelected() !== want) node.setSelected(want);
    });
    syncing.current = false;
  }, [selected]);

  useEffect(syncSelection, [syncSelection, rows]);

  const columns = useMemo<ColDef<RequestItem>[]>(
    () => [
      {
        field: "text",
        headerName: "Client request",
        flex: 3,
        minWidth: 240,
        wrapText: true,
        autoHeight: true,
        tooltipField: "reason",
      },
      {
        field: "label",
        headerName: "Label",
        width: 165,
        refData: LABELS,
        editable: (p) => !p.data?.billedInOrderId,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: Object.keys(LABELS) },
        cellRenderer: (p: { value: Label }) => <span className={`pill ${p.value}`}>{LABELS[p.value]}</span>,
      },
      {
        field: "minutes",
        headerName: "Time",
        width: 110,
        type: "rightAligned",
        editable: (p) => p.data?.label === "out_of_scope" && !p.data.billedInOrderId,
        cellEditor: "agNumberCellEditor",
        cellEditorParams: { min: 0, max: 2400, precision: 0 },
        valueFormatter: (p) => (p.data?.label === "out_of_scope" ? duration(p.value ?? 0) : "-"),
      },
      {
        colId: "state",
        headerName: "Status",
        width: 190,
        valueGetter: (p) => {
          const r = p.data;
          if (!r) return "";
          if (r.billedInOrderId) return "In a change order";
          if (r.injectionSuspected) return "Trick message ignored";
          if (r.downgraded) return "Citation not found, review";
          if (r.label === "out_of_scope") return r.reviewed ? "Ready to bill" : "AI estimate, review";
          return r.label === "in_scope" ? "Covered by the agreement" : "Ask the client";
        },
      },
      {
        colId: "clause",
        headerName: "Clause relied on",
        flex: 2,
        minWidth: 200,
        valueGetter: (p) => p.data?.citedQuotes.join(" | ") ?? "",
        tooltipValueGetter: (p) => p.value,
      },
    ],
    [],
  );

  return (
    <div className="grid-box request-grid">
      <AgGridReact<RequestItem>
        rowData={rows}
        columnDefs={columns}
        domLayout="autoHeight"
        getRowId={(p) => p.data.id}
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        rowSelection={{
          mode: "multiRow",
          isRowSelectable: (node) => Boolean(node.data && canBill(node.data)),
          hideDisabledCheckboxes: true,
          enableClickSelection: false,
        }}
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        tooltipShowDelay={300}
        onGridReady={(event) => {
          apiRef.current = event.api;
          syncSelection();
        }}
        onSelectionChanged={(event) => {
          if (syncing.current) return;
          onSelect(new Set(event.api.getSelectedRows().map((r) => r.id)));
        }}
        onCellValueChanged={(event) => {
          if (event.newValue === event.oldValue) return;
          if (event.colDef.field === "label") onChange(event.data.id, { label: event.newValue as Label });
          if (event.colDef.field === "minutes") {
            const minutes = Math.round(Number(event.newValue) || 0);
            if (minutes >= 0 && minutes <= 2400) onChange(event.data.id, { minutes });
          }
        }}
      />
      <p className="muted small">Click a label or time to change it. Tick the extras you want to bill.</p>
    </div>
  );
}

function RequestRow({
  request,
  selected,
  onToggle,
  onChange,
}: {
  request: RequestItem;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onChange: (changes: { label?: Label; minutes?: number }) => void;
}) {
  const [minutes, setMinutes] = useState(String(request.minutes || ""));
  const locked = Boolean(request.billedInOrderId);
  const canSelect = request.label === "out_of_scope" && !locked && request.minutes > 0;

  return (
    <li className={`request ${request.label}`}>
      <div className="request-head">
        {canSelect && (
          <input
            type="checkbox"
            aria-label={`Include: ${request.text}`}
            checked={selected}
            onChange={(e) => onToggle(e.target.checked)}
          />
        )}
        <p className="request-text">{request.text}</p>
        <span className={`pill ${request.label}`}>{LABELS[request.label]}</span>
      </div>

      <p className="muted small">{request.reason}</p>
      {request.citedQuotes.map((quote) => (
        <blockquote key={quote}>{quote}</blockquote>
      ))}
      {request.injectionSuspected && (
        <p className="warning small">This message tried to give the AI instructions, and they were ignored.</p>
      )}
      {request.downgraded && (
        <p className="warning small">The AI's citation wasn't in the agreement, so please review this one.</p>
      )}

      {locked ? (
        <p className="muted small">Added to a change order · {duration(request.minutes)}</p>
      ) : (
        <div className="request-controls">
          <label>
            Label
            <select value={request.label} onChange={(e) => onChange({ label: e.target.value as Label })}>
              {Object.entries(LABELS).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          {request.label === "out_of_scope" && (
            <label>
              Minutes
              <input
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))}
                onBlur={() => {
                  const value = Number(minutes || 0);
                  if (value !== request.minutes && value <= 2400) onChange({ minutes: value });
                }}
              />
            </label>
          )}
          {request.label === "out_of_scope" && !request.reviewed && <span className="muted small">AI estimate</span>}
        </div>
      )}
    </li>
  );
}

function ScopeList({ view }: { view: FreelancerView }) {
  return (
    <section className="card">
      <h2>Agreed scope</h2>
      <ul className="scope-list">
        {view.project.scope.map((item) => (
          <li key={item.id}>
            <span className={`kind ${item.kind}`}>{KINDS[item.kind]}</span>
            <span>
              {item.text}
              {item.priceCents !== undefined && <span className="muted"> · {money(item.priceCents)}</span>}
            </span>
          </li>
        ))}
      </ul>
      {view.project.later.length > 0 && (
        <>
          <h3>Left for later</h3>
          <ul className="plain-list">
            {view.project.later.map((line) => (
              <li key={line.requestId}>
                {line.description} <span className="muted">· {money(line.amountCents)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Orders({ view, base, token, run }: SectionProps) {
  if (view.orders.length === 0) return null;
  return (
    <section>
      <h2 className="section-title">Change orders</h2>
      <div className="order-list">
        {[...view.orders].reverse().map((stored) => (
          <OrderCard
            key={`${stored.order.id}-${stored.order.version}-${stored.order.status}`}
            stored={stored}
            base={`${base}/orders/${stored.order.id}`}
            token={token}
            run={run}
          />
        ))}
      </div>
    </section>
  );
}

function OrderCard({
  stored,
  base,
  token,
  run,
}: {
  stored: StoredOrder;
  base: string;
  token: string;
  run: SectionProps["run"];
}) {
  const { order } = stored;
  const [message, setMessage] = useState(order.message);
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.lines.map((l) => [l.requestId, (l.amountCents / 100).toFixed(2)])),
  );

  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.lines.map((l) => [l.requestId, l.description])),
  );

  const editable = order.status === "draft" || order.status === "approved";
  const total = order.lines.reduce((sum, l) => sum + l.amountCents, 0);
  const valid = order.lines.every(
    (l) => (toCents(prices[l.requestId] ?? "") ?? 0) > 0 && (names[l.requestId] ?? "").trim(),
  );
  const dirty =
    message !== order.message ||
    order.lines.some(
      (l) => toCents(prices[l.requestId] ?? "") !== l.amountCents || names[l.requestId] !== l.description,
    );

  const save = () =>
    run(() =>
      api("PATCH", base, {
        token,
        body: {
          message,
          lines: order.lines.map((l) => ({
            requestId: l.requestId,
            description: names[l.requestId],
            amountCents: toCents(prices[l.requestId] ?? ""),
          })),
        },
      }),
    );

  return (
    <article className="card order">
      <div className="order-head">
        <h3>Change order · {money(order.amountDueCents ?? total)}</h3>
        <span className={`status ${order.status}`}>{statusText(stored)}</span>
      </div>

      {editable ? (
        <label>
          Note to the client
          <textarea rows={6} value={message} maxLength={4000} onChange={(e) => setMessage(e.target.value)} />
        </label>
      ) : (
        <p className="client-note">{order.message}</p>
      )}

      <ul className="order-lines">
        {order.lines.map((line) => (
          <li key={line.requestId}>
            {editable ? (
              <label className="line-name">
                <span className="visually-hidden">Item name shown to the client and on the invoice</span>
                <input
                  maxLength={500}
                  value={names[line.requestId] ?? ""}
                  onChange={(e) => setNames({ ...names, [line.requestId]: e.target.value })}
                />
              </label>
            ) : (
              <span>{line.description}</span>
            )}
            <span className="muted small">{duration(line.minutes)}</span>
            {editable ? (
              <label className="price">
                <span className="visually-hidden">Price for {line.description}</span>$
                <input
                  inputMode="decimal"
                  value={prices[line.requestId] ?? ""}
                  onChange={(e) => setPrices({ ...prices, [line.requestId]: e.target.value })}
                />
              </label>
            ) : (
              <strong>{money(line.amountCents)}</strong>
            )}
            {order.choices?.[line.requestId] && (
              <span className="choice-tag">{choiceText(order.choices[line.requestId]!.type)}</span>
            )}
          </li>
        ))}
      </ul>

      {editable && (
        <div className="order-actions">
          {dirty ? (
            <button className="primary" disabled={!valid || !message.trim()} onClick={save}>
              Save changes
            </button>
          ) : order.status === "draft" ? (
            <button className="primary" onClick={() => run(() => api("POST", `${base}/approve`, { token }))}>
              Approve for client
            </button>
          ) : (
            <p className="muted small">Approved. Your client can now respond from their page.</p>
          )}
          <button className="plain danger" onClick={() => run(() => api("DELETE", base, { token }))}>
            Delete
          </button>
        </div>
      )}

      {order.status === "awaiting_payment" && (
        <div className="order-actions">
          <p className="muted small">
            {stored.lastReminderAt
              ? `PayPal reminder sent ${new Date(stored.lastReminderAt).toLocaleString()}.`
              : order.invoiceId
                ? "Your client has a PayPal invoice. This updates by itself when they pay."
                : "Your client hasn't opened the PayPal invoice yet."}
          </p>
          <div className="order-buttons">
            {order.invoiceId && (
              <button className="plain" onClick={() => run(() => api("POST", `${base}/remind`, { token }))}>
                Send PayPal reminder
              </button>
            )}
            <button
              className="plain danger"
              onClick={() => {
                if (window.confirm("Cancel the PayPal invoice and let your client choose again?")) {
                  void run(() => api("POST", `${base}/withdraw`, { token }));
                }
              }}
            >
              Withdraw
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function statusText({ order, invoiceStatus }: StoredOrder): string {
  if (order.status === "draft") return "Draft";
  if (order.status === "approved") return "Waiting for client";
  if (order.status === "complete") return order.paymentTransactionId ? "Paid" : "Complete";
  return invoiceStatus ? `Awaiting payment (${invoiceStatus})` : "Awaiting payment";
}

function choiceText(type: string): string {
  return type === "pay" ? "Client added it" : type === "swap" ? "Client swapped" : "Left for later";
}

function Ledger({ orders }: { orders: StoredOrder[] }) {
  const rows = useMemo(
    () =>
      orders.flatMap((stored) =>
        stored.order.lines.map((line) => ({
          id: `${stored.order.id}-${line.requestId}`,
          item: line.description,
          time: line.minutes,
          amount: line.amountCents,
          charged: stored.order.chargesCents?.[line.requestId] ?? null,
          choice: stored.order.choices?.[line.requestId]?.type ?? null,
          status:
            stored.order.choices?.[line.requestId]?.type === "defer" ? "Not charged" : statusText(stored),
          tone:
            stored.order.choices?.[line.requestId]?.type === "defer"
              ? ""
              : stored.order.status === "complete" || stored.order.status === "awaiting_payment"
                ? stored.order.status
                : "",
          invoice: stored.order.invoiceId ?? "",
          payment: stored.order.paymentTransactionId ?? "",
        })),
      ),
    [orders],
  );

  type Row = (typeof rows)[number];
  const [search, setSearch] = useState("");
  const apiRef = useRef<GridApi<Row> | null>(null);

  // A pinned row keeps the totals in view however the ledger is sorted or filtered.
  const totals = useMemo<Row[]>(
    () => [
      {
        id: "total",
        item: "Total",
        time: rows.reduce((sum, r) => sum + r.time, 0),
        amount: rows.reduce((sum, r) => sum + r.amount, 0),
        charged: rows.reduce((sum, r) => sum + (r.charged ?? 0), 0),
        choice: null,
        status: "",
        tone: "",
        invoice: "",
        payment: "",
      },
    ],
    [rows],
  );

  const columns = useMemo<ColDef<Row>[]>(
    () => [
      { field: "item", headerName: "Item", flex: 2, minWidth: 220 },
      { field: "time", headerName: "Time", width: 95, valueFormatter: (p) => duration(p.value ?? 0) },
      { field: "amount", headerName: "Quoted", width: 110, type: "rightAligned", valueFormatter: (p) => money(p.value) },
      {
        field: "charged",
        headerName: "Charged",
        width: 110,
        type: "rightAligned",
        valueFormatter: (p) => (p.value === null || p.value === undefined ? "-" : money(p.value)),
      },
      {
        field: "choice",
        headerName: "Client choice",
        width: 150,
        valueFormatter: (p) => (p.node?.rowPinned ? "" : p.value ? choiceText(p.value) : "No answer yet"),
      },
      {
        field: "status",
        headerName: "Status",
        width: 200,
        cellRenderer: (p: { value: string; data?: Row }) =>
          p.value ? <span className={`status ${p.data?.tone ?? ""}`}>{p.value}</span> : null,
      },
      { field: "invoice", headerName: "PayPal invoice", width: 225 },
      { field: "payment", headerName: "PayPal payment", width: 190 },
    ],
    [],
  );

  if (rows.length === 0) return null;
  return (
    <section>
      <div className="grid-head">
        <h2 className="section-title">Project ledger</h2>
        <div className="grid-tools">
          <label className="visually-hidden" htmlFor="ledger-search">
            Search the ledger
          </label>
          <input
            id="ledger-search"
            type="search"
            placeholder="Search the ledger"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className="plain"
            onClick={() =>
              apiRef.current?.exportDataAsCsv({ fileName: "scopebill-ledger.csv", processCellCallback: exportCell })
            }
          >
            Export CSV
          </button>
        </div>
      </div>
      <div className="ledger grid-box">
        <AgGridReact<Row>
          rowData={rows}
          columnDefs={columns}
          domLayout="autoHeight"
          getRowId={(p) => p.data.id}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          quickFilterText={search}
          pinnedBottomRowData={totals}
          getRowClass={(p) => (p.node.rowPinned ? "total-row" : undefined)}
          onGridReady={(event) => {
            apiRef.current = event.api;
          }}
        />
      </div>
    </section>
  );
}

function eventDetail(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof detail.label === "string") parts.push(LABELS[detail.label as Label] ?? detail.label);
  if (Array.isArray(detail.choices)) parts.push(detail.choices.map((c) => choiceText(String(c))).join(", "));
  if (typeof detail.amountDueCents === "number") parts.push(`${money(detail.amountDueCents)} due`);
  if (typeof detail.paidAmount === "string") parts.push(`$${detail.paidAmount} paid`);
  if (typeof detail.invoiceId === "string") parts.push(`Invoice ${detail.invoiceId}`);
  if (typeof detail.transactionId === "string") parts.push(`Payment ${detail.transactionId}`);
  if (typeof detail.eventType === "string") parts.push(detail.eventType);
  if (detail.injectionSuspected === true) parts.push("Trick message ignored");
  if (detail.downgraded === true) parts.push("Citation not found");
  return parts.join(" · ");
}

/** Every action on the project, as a grid you can filter by who did it and export as evidence. */
function Timeline({ view }: { view: FreelancerView }) {
  const [open, setOpen] = useState(false);
  const apiRef = useRef<GridApi | null>(null);

  const rows = useMemo(
    () =>
      [...view.events].reverse().map((event, index) => ({
        id: `${event.at}-${view.events.length - index}`,
        at: event.at,
        who: ACTORS[event.actor] ?? event.actor,
        what: EVENT_TEXT[event.type] ?? event.type,
        detail: eventDetail(event.detail),
      })),
    [view.events],
  );

  const columns = useMemo<ColDef<(typeof rows)[number]>[]>(
    () => [
      {
        field: "at",
        headerName: "When",
        width: 190,
        sort: "desc",
        valueFormatter: (p) => new Date(p.value).toLocaleString(),
      },
      { field: "who", headerName: "Who", width: 130 },
      { field: "what", headerName: "What happened", flex: 2, minWidth: 220 },
      { field: "detail", headerName: "Details", flex: 2, minWidth: 220, tooltipField: "detail" },
    ],
    [],
  );

  return (
    <details className="card timeline" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Audit trail ({view.events.length})</summary>
      {open && (
        <>
          <div className="grid-tools audit-tools">
            <span className="muted small">Filter the Who column to see only what the AI, PayPal or a person did.</span>
            <button
              className="plain"
              onClick={() =>
                apiRef.current?.exportDataAsCsv({ fileName: "scopebill-audit-trail.csv", processCellCallback: exportCell })
              }
            >
              Export CSV
            </button>
          </div>
          <div className="grid-box">
            <AgGridReact
              rowData={rows}
              columnDefs={columns}
              domLayout="autoHeight"
              getRowId={(p) => p.data.id}
              defaultColDef={{ sortable: true, filter: true, resizable: true }}
              pagination={rows.length > 20}
              paginationPageSize={20}
              paginationPageSizeSelector={false}
              tooltipShowDelay={300}
              onGridReady={(event) => {
                apiRef.current = event.api;
              }}
            />
          </div>
        </>
      )}
    </details>
  );
}

interface DraftItem {
  kind: Kind;
  text: string;
  sourceQuote: string;
  price: string;
}

function SetupScope({ view, base, token, run }: SectionProps) {
  const [items, setItems] = useState<DraftItem[]>([]);
  const [rejected, setRejected] = useState(0);
  const [busy, setBusy] = useState(false);

  const extract = async () => {
    setBusy(true);
    await run(async () => {
      const result = await api<{ items: Omit<DraftItem, "price">[]; rejected: unknown[] }>(
        "POST",
        `${base}/scope/extract`,
        { token },
      );
      setItems(result.items.map((item) => ({ ...item, price: "" })));
      setRejected(result.rejected.length);
    });
    setBusy(false);
  };

  const update = (index: number, changes: Partial<DraftItem>) =>
    setItems(items.map((item, i) => (i === index ? { ...item, ...changes } : item)));

  const valid = items.length > 0 && items.every((i) => i.text.trim() && (!i.price || toCents(i.price) !== null));

  const confirm = () =>
    run(() =>
      api("PUT", `${base}/scope`, {
        token,
        body: {
          items: items.map(({ price, ...item }) => ({
            ...item,
            ...(price ? { priceCents: toCents(price) } : {}),
          })),
        },
      }),
    );

  return (
    <section className="card">
      <h1>{view.project.title}</h1>
      <p className="muted">First, turn your agreement into a checklist. You stay in control of what goes in it.</p>
      <details>
        <summary>Your agreement</summary>
        <pre className="agreement">{view.project.agreement}</pre>
      </details>

      {items.length === 0 ? (
        <button className="primary" disabled={busy} onClick={extract}>
          {busy ? "Reading the agreement..." : "Read my agreement"}
        </button>
      ) : (
        <>
          {rejected > 0 && (
            <p className="warning small">
              {rejected} {rejected === 1 ? "item was" : "items were"} removed because the quote wasn't in your agreement.
            </p>
          )}
          <ul className="setup-list">
            {items.map((item, index) => (
              <li key={index}>
                <select
                  aria-label="Item type"
                  value={item.kind}
                  onChange={(e) => update(index, { kind: e.target.value as Kind })}
                >
                  {Object.entries(KINDS).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Item"
                  value={item.text}
                  onChange={(e) => update(index, { text: e.target.value })}
                />
                {item.kind === "deliverable" && (
                  <input
                    aria-label="Price if swapped out, in dollars"
                    className="short"
                    inputMode="decimal"
                    placeholder="Swap $"
                    value={item.price}
                    onChange={(e) => update(index, { price: e.target.value })}
                  />
                )}
                <button
                  className="plain danger"
                  aria-label={`Remove ${item.text}`}
                  onClick={() => setItems(items.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">Add a price to any deliverable your client may swap out.</p>
          <button className="primary" disabled={!valid} onClick={confirm}>
            Confirm scope
          </button>
        </>
      )}
    </section>
  );
}
