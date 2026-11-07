import { useState, type FormEvent } from "react";
import { api, toCents, type Created } from "./api";

export function Home() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const open = (created: Created) => {
    location.hash = `#/p/${created.project.id}/${created.freelancerToken}`;
  };

  const openSample = async () => {
    setCreating(true);
    setError(null);
    try {
      open(await api<Created>("POST", "/api/demo"));
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rate = toCents(String(form.get("rate")));
    if (rate === null || rate <= 0) {
      setError("Enter an hourly rate, such as 100");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      open(
        await api<Created>("POST", "/api/projects", {
          body: {
            title: form.get("title"),
            freelancerName: form.get("freelancerName"),
            clientName: form.get("clientName"),
            clientEmail: form.get("clientEmail"),
            hourlyRateCents: rate,
            agreement: form.get("agreement"),
          },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <main className="home">
      <p className="brand">ScopeBill</p>
      <h1>Get paid for "can you just..." without the awkward conversation.</h1>
      <p className="lede">
        Small favors add up. ScopeBill tracks them against your agreement and shows the running total. It prepares a
        polite change order, then lets your client pay for the extra work, swap something out, or leave it for later.
      </p>

      <div className="home-actions">
        <button className="primary large" onClick={openSample} disabled={creating}>
          {creating ? "Opening..." : "Open the sample project"}
        </button>
        <button className="plain large" onClick={() => setShowForm(!showForm)} aria-expanded={showForm}>
          Start your own
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {showForm && (
        <form className="card form-grid" onSubmit={submit}>
          <label className="wide">
            Project name
            <input name="title" required maxLength={200} />
          </label>
          <label>
            Your name
            <input name="freelancerName" required maxLength={100} />
          </label>
          <label>
            Client name
            <input name="clientName" required maxLength={100} />
          </label>
          <label>
            Client's sandbox email
            <input name="clientEmail" type="email" required placeholder="name@personal.example.com" />
          </label>
          <label>
            Hourly rate (USD)
            <input name="rate" inputMode="decimal" required placeholder="100" />
          </label>
          <label className="wide">
            Paste your agreement
            <textarea name="agreement" rows={8} required maxLength={30000} />
          </label>
          <div className="wide">
            <button className="primary" disabled={creating}>
              Create project
            </button>
          </div>
        </form>
      )}

      <p className="fine-print">
        This is a hackathon demo running in the PayPal sandbox, so no real money moves. It doesn't give legal advice.
        Use made-up details, not a real contract.
      </p>
    </main>
  );
}
