# ScopeBill

**Get paid for "can you just..." without the awkward conversation.**

Freelancers rarely lose money on one big extra request. They lose it through small favors they feel awkward charging for. ScopeBill checks client requests against the agreement and keeps a running total of unbilled work. It prepares a polite change order, then lets the client **pay for it, swap something out, or leave it for later**. PayPal handles the payment, and a person approves every step.

Why it's needed: in [Ignition's 2025 survey of 273 US agency leaders](https://www.ignitionapp.com/news/2025-agency-pricing-cashflow-report), only 1% said they bill for all out-of-scope work. Ignition sells billing software, and that survey covers agencies, not solo freelancers.

**Live demo:** <https://scopebill.onrender.com> (can take about a minute to wake up)

**Demo video:** <https://youtu.be/lvx9rxPvGVM>

**Status:** working end to end in the PayPal sandbox, with real sandbox payments confirmed. Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). No real money moves.

## Screenshots

| Small favors add up | A trick message doesn't work |
|---|---|
| ![Dashboard showing $825 of unbilled work](docs/screenshots/01-running-total.png) | ![A trick message stays out of scope, with a warning](docs/screenshots/02-trick-message-blocked.png) |

| The client gets a choice | Every charge is tracked |
|---|---|
| ![Client page with pay, swap and later choices](docs/screenshots/04-client-choices.png) | ![Ledger with quoted and charged amounts, and the audit trail](docs/screenshots/07-ledger-and-audit-trail.png) |

Screenshots show sample data in the PayPal sandbox.

## Who is it for

- **Freelancers with direct clients** — designers, developers, writers, marketers and anyone else who finds work outside Upwork or Fiverr and has no platform protecting them.
- **Small studios and agencies** running fixed-quote projects where "small favors" quietly eat the margin.
- **Their clients, too.** They see exactly what the agreement covers, get a polite change order instead of an awkward argument, and keep a real choice: pay for the extra, swap something out, or leave it for later.

## Try it

1. Click **Open the sample project**. It needs no setup and uses no AI credits.
2. Paste a new client request and click **Check request**.
3. Select the extras, click **Prepare change order**, then edit and approve it.
4. Click **Open client page**, and choose pay, swap or defer for each item.
5. Click **Pay with PayPal** and sign in as a sandbox buyer. For the submitted demo, test buyer details are in the Devpost testing instructions.
6. Return to the dashboard to see the payment, the updated scope and the ledger.

## Run it

You need [Bun](https://bun.sh/), a PayPal sandbox app with Invoicing enabled, and an OpenRouter key.

```bash
git clone https://github.com/rushibhosalepro/scopebill.git
```

```bash
cd scopebill
```

```bash
bun install
```

```bash
cp .env.example .env
```

Fill in the required names below, then run:

```bash
bun run start
```

Open <http://localhost:3000>.

## Environment

| Name | Required | What it's for |
|---|---|---|
| `PAYPAL_BASE_URL` | Yes | Must be the PayPal sandbox address, already set in `.env.example` |
| `PAYPAL_CLIENT_ID` | Yes | Sandbox app client ID |
| `PAYPAL_CLIENT_SECRET` | Yes | Sandbox app secret |
| `PAYPAL_SANDBOX_BUYER_EMAIL` | For the sample project | Sandbox buyer who receives sample invoices |
| `OPENROUTER_API_KEY` | Yes | AI requests |
| `OPENROUTER_MODEL` | Yes | Model name, already set in `.env.example` |
| `PAYPAL_WEBHOOK_ID` | No | Reserved for webhooks, which the app doesn't need |
| `PORT` | No | Server port, 3000 by default |
| `DATABASE_PATH` | No | SQLite file path |

## Stack

| Layer | What's running |
|---|---|
| Server | Bun and TypeScript |
| Screens | React, with AG Grid for the ledger |
| Data | SQLite |
| Rules | Plain code for prices, totals, approvals and payment checks |
| AI | OpenRouter with `openai/gpt-oss-120b` |
| Payments | PayPal Invoicing API v2, sandbox only |
| Hosting | Docker and a Render blueprint |

## Layout

```text
src/core/     Scope, pricing, approval and payment rules
src/ai/       OpenRouter client and scope prompts
src/paypal/   Sandbox-only PayPal client
src/server/   API, database, sample project and static files
web/          Freelancer and client screens
scripts/      AI test, PayPal test and live flow check
```

## How it works

| Step | Who decides | What happens |
|---|---|---|
| Read the agreement | AI, then the freelancer | The agreement becomes a checklist, and the freelancer confirms it |
| Check a request | AI, then the freelancer | Labeled in scope, out of scope or needs clarifying, with a citation |
| Add it up | Code | Running total of open, out-of-scope work |
| Draft the change order | AI, then the freelancer | Polite note and items, which the freelancer edits and approves |
| Respond | Client | Pay, swap or defer each item |
| Bill | Code and PayPal | PayPal invoice for the exact amount due |
| Confirm | PayPal | Scope and ledger update only after PayPal reports the invoice as paid |

## Why you can trust it

- **People decide, the AI assists.** The freelancer confirms the scope, edits and approves every change order; the client chooses pay, swap or defer. Nothing is billed on the AI's say-so.
- **The AI never touches money.** It has no payment tools. Only server code can create an invoice, and only after a human approval.
- **Every label shows its proof.** Each in-scope or out-of-scope label from the AI quotes the agreement it relied on. If a quote can't be found in the agreement, the request is flagged for human review instead of being billed.
- **Payment must be proven.** The scope and ledger change only after PayPal itself reports the invoice as paid, with the amount and transaction matching exactly.
- **Test money only.** The app refuses to run against anything but the PayPal sandbox, enforced in code.
- **A receipt for everything.** Every request, label, approval, choice and payment is logged in an audit trail on the freelancer's dashboard. The client page shows their change orders and payment status.

**A few more rules enforced in code:**

- **The AI can't set prices.** Prices come from approved time and the freelancer's rate, or a price they enter.
- **Client messages are data.** Instructions inside a message can't change prices or approvals, and the app warns the freelancer when the AI spots an attempt.
- **Approval covers the exact content.** Any later edit requires a new approval.
- **A partial or manually marked payment doesn't count.**
- **Invoices can only go to sandbox test accounts.**

ScopeBill helps with communication and billing. It isn't legal advice, and the agreement still governs.

## Test results

One run of 30 sample client messages across 3 different agreements, using `openai/gpt-oss-120b`. Expected answers were written before the run.

| Measure | Result |
|---|---|
| Out-of-scope requests caught | 16 of 17, and the other went to the freelancer for review |
| Requests correctly not marked billable | 13 of 13 in-scope or unclear requests |
| Labels matching the expected answer | 29 of 30 |
| Trick messages that changed a label | 0 of 2 |
| Trick messages flagged | 1 of 2 |
| Invented quotes caught before billing | 1 of 1 |
| Cost | About $0.003 |

The miss was "Can you design some Instagram post templates to match?". The AI's quote wasn't in the agreement, so the request dropped to "needs clarifying".

This is an internal test written by the author, from a single run. It isn't proof of real-world accuracy.

| Command | Purpose |
|---|---|
| `bun test` | Run the automated tests |
| `bun run typecheck` | Check types |
| `bun run ai:eval` | Run the AI test using your OpenRouter credits |

## PayPal integration

| Feature | Use |
|---|---|
| Invoicing API v2 | Generate a number, create, send and read invoices |
| Status checks | Confirm payment by reading the invoice from PayPal |
| OAuth 2.0 | Server-side sandbox authentication |

Webhooks aren't required, because the app reads invoice status directly.

## AI tools

| Tool | Use |
|---|---|
| [OpenRouter](https://openrouter.ai/) with `openai/gpt-oss-120b` | Reads agreements, labels requests, suggests time and drafts client notes |

Any OpenRouter model with structured output support can be set using `OPENROUTER_MODEL`.

## Deploy to Render

This repo includes a [Dockerfile](Dockerfile) and a [render.yaml](render.yaml) blueprint. In Render, create a new Blueprint from your repo, then enter the values it asks for: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_SANDBOX_BUYER_EMAIL` and `OPENROUTER_API_KEY`.

The free plan uses temporary storage. It can take about a minute to wake up, and saved projects can disappear when it restarts, so start again from the sample project if a link stops working.

## Limits

- **Sandbox only:** every payment is a test payment.
- **One seller account:** the demo uses one PayPal sandbox merchant. Connecting many freelancers' accounts isn't built.
- **Messages are pasted in:** the app doesn't watch email or Slack.
- **Time estimates are rough:** they're suggestions for the freelancer to set.
- **Project links are private links:** anyone with a link can open that project. There are no user accounts.

## License

[MIT](LICENSE)
