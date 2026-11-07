import { useCallback, useEffect, useState } from "react";
import { api, money, safePayUrl, type Choice, type ClientOrder, type ClientView } from "./api";

export function ClientPage({ token }: { token: string }) {
  const [view, setView] = useState<ClientView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setView(await api<ClientView>("GET", `/api/client/${token}`));
  }, [token]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  const pollKey = (view?.orders ?? [])
    .filter((o) => o.status === "awaiting_payment" && o.invoiceStatus)
    .map((o) => o.id)
    .join();

  useEffect(() => {
    if (!pollKey) return;
    const timer = setInterval(() => {
      void (async () => {
        for (const id of pollKey.split(",")) {
          setView(await api<ClientView>("POST", `/api/client/${token}/orders/${id}/refresh`));
        }
      })().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [pollKey, token]);

  if (!view) {
    return (
      <main className="page narrow">
        {error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading...</p>}
      </main>
    );
  }

  const open = view.orders.filter((o) => o.status !== "complete");
  const done = view.orders.filter((o) => o.status === "complete");

  return (
    <>
      <header className="topbar">
        <span className="brand">ScopeBill</span>
        <span className="sandbox-tag">PayPal sandbox, no real money</span>
      </header>
      <main className="page narrow">
        <h1>{view.project.title}</h1>
        <p className="muted">From {view.project.freelancerName}, for {view.project.clientName}</p>

        {open.length === 0 && done.length === 0 && (
          <section className="card">
            <p>Nothing needs your attention right now.</p>
          </section>
        )}

        {open.map((order) => (
          <OrderResponse key={order.id} order={order} view={view} token={token} setView={setView} />
        ))}

        {done.map((order) => (
          <section className="card" key={order.id}>
            <div className="order-head">
              <h2>{order.paid ? `Paid ${money(order.amountDueCents)}` : "All set"}</h2>
              <span className="status complete">Complete</span>
            </div>
            <p className="muted">Thank you. The project has been updated with your choices.</p>
          </section>
        ))}

        {view.project.later.length > 0 && (
          <section className="card">
            <h2>Left for later</h2>
            <ul className="plain-list">
              {view.project.later.map((item) => (
                <li key={item.description}>{item.description}</li>
              ))}
            </ul>
          </section>
        )}

        {view.includedRequests.length > 0 && (
          <section className="card">
            <h2>Already included</h2>
            <p className="muted small">These requests are covered by your agreement at no extra cost.</p>
            <ul className="included">
              {view.includedRequests.map((request) => (
                <li key={request.id}>
                  <p>{request.text}</p>
                  {request.citedQuotes.map((quote) => (
                    <blockquote key={quote}>{quote}</blockquote>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="fine-print">
          ScopeBill helps with communication and billing. It isn't legal advice, and your agreement still governs.
        </p>
      </main>
    </>
  );
}

function OrderResponse({
  order,
  view,
  token,
  setView,
}: {
  order: ClientOrder;
  view: ClientView;
  token: string;
  setView: (view: ClientView) => void;
}) {
  const [choices, setChoices] = useState<Record<string, Choice | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/client/${token}/orders/${order.id}`;
  const swappable = view.project.scope.filter((s) => s.kind === "deliverable" && s.priceCents !== undefined);
  const taken = new Set(
    Object.values(choices).flatMap((c) => (c?.type === "swap" ? [c.removedScopeItemId] : [])),
  );

  const lineDue = (line: ClientOrder["lines"][number]): number => {
    const choice = choices[line.requestId];
    if (choice?.type === "pay") return line.amountCents;
    if (choice?.type === "swap") {
      const item = swappable.find((s) => s.id === choice.removedScopeItemId);
      return line.amountCents - (item?.priceCents ?? line.amountCents);
    }
    return 0;
  };
  const due = order.lines.reduce((sum, line) => sum + lineDue(line), 0);
  const complete = order.lines.every((line) => {
    const choice = choices[line.requestId];
    return choice && (choice.type !== "swap" || choice.removedScopeItemId);
  });

  const createInvoice = useCallback(async () => {
    setView(await api<ClientView>("POST", `${base}/invoice`));
  }, [base, setView]);

  const needsInvoice = order.status === "awaiting_payment" && !order.invoiceStatus;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api<ClientView>("POST", `${base}/choices`, { body: { choices } });
      setView(updated);
      const next = updated.orders.find((o) => o.id === order.id);
      if (next?.status === "awaiting_payment") await createInvoice();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await createInvoice();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  if (order.status === "awaiting_payment") {
    const payUrl = safePayUrl(order.payerViewUrl);
    return (
      <section className="card pay-card">
        <p className="eyebrow">Amount due</p>
        <p className="big-number">{money(order.amountDueCents)}</p>
        {error && <p className="error" role="alert">{error}</p>}
        {needsInvoice ? (
          <button className="primary large" disabled={busy} onClick={retry}>
            {busy ? "Preparing your invoice..." : "Prepare PayPal invoice"}
          </button>
        ) : payUrl ? (
          <>
            <a className="pay-button" href={payUrl} target="_blank" rel="noreferrer">
              Pay with PayPal
            </a>
            <p className="muted small" aria-live="polite">
              This page updates by itself after PayPal confirms your payment.
            </p>
          </>
        ) : (
          <p className="error">PayPal didn't return a payment link. Please contact {view.project.freelancerName}.</p>
        )}
        <ul className="chosen">
          {order.lines.map((line) => {
            const type = order.choices?.[line.requestId]?.type;
            return (
              <li key={line.requestId}>
                <span>{line.description}</span>
                <span>{type === "pay" ? "Added" : type === "swap" ? "Swapped" : "Later"}</span>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>A few extras to decide on</h2>
      <p className="client-note">{order.message}</p>

      <div className="choice-list">
        {order.lines.map((line) => {
          const choice = choices[line.requestId];
          const set = (next: Choice | undefined) => setChoices({ ...choices, [line.requestId]: next });
          const options = swappable.filter(
            (s) =>
              (s.priceCents ?? 0) <= line.amountCents &&
              (!taken.has(s.id) || (choice?.type === "swap" && choice.removedScopeItemId === s.id)),
          );
          return (
            <fieldset key={line.requestId} className="choice">
              <legend>
                <span>{line.description}</span>
                <strong>{money(line.amountCents)}</strong>
              </legend>
              <label className={choice?.type === "pay" ? "option on" : "option"}>
                <input type="radio" name={line.requestId} checked={choice?.type === "pay"} onChange={() => set({ type: "pay" })} />
                <span>
                  <strong>Add it</strong>
                  <small>Pay {money(line.amountCents)}</small>
                </span>
              </label>
              <label className={choice?.type === "swap" ? "option on" : "option"}>
                <input
                  type="radio"
                  name={line.requestId}
                  disabled={options.length === 0}
                  checked={choice?.type === "swap"}
                  onChange={() => set({ type: "swap", removedScopeItemId: options[0]?.id ?? "" })}
                />
                <span>
                  <strong>Swap something out</strong>
                  <small>{options.length === 0 ? "No item available to swap" : "Pay only the difference"}</small>
                </span>
              </label>
              {choice?.type === "swap" && (
                <label className="swap-select">
                  Replace
                  <select
                    value={choice.removedScopeItemId}
                    onChange={(e) => set({ type: "swap", removedScopeItemId: e.target.value })}
                  >
                    {options.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.text} ({money(item.priceCents)})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className={choice?.type === "defer" ? "option on" : "option"}>
                <input type="radio" name={line.requestId} checked={choice?.type === "defer"} onChange={() => set({ type: "defer" })} />
                <span>
                  <strong>Leave it for later</strong>
                  <small>No work and no charge for now</small>
                </span>
              </label>
            </fieldset>
          );
        })}
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      <div className="confirm-bar">
        <div>
          <p className="eyebrow">Total to pay</p>
          <p className="total">{money(due)}</p>
        </div>
        <button className="primary large" disabled={!complete || busy} onClick={submit}>
          {busy ? "Saving..." : due > 0 ? "Confirm and continue to PayPal" : "Confirm choices"}
        </button>
      </div>
    </section>
  );
}
