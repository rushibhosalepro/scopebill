# ScopeBill

**Get paid for "can you just..." without the awkward conversation.**

Freelancers rarely lose money on one big extra request. They lose it through small favors they feel awkward charging for. ScopeBill checks client requests against the agreement and keeps a running total of unbilled work. It prepares a polite change order, then lets the client **pay for it, swap something out, or leave it for later**. PayPal handles the payment, and a person approves every step.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). It runs only in the PayPal sandbox, so no real money moves.

## Try it

1. Click **Open the sample project**. It needs no setup and uses no AI credits.
2. Paste a new client request and click **Check request**.
3. Select the extras, click **Prepare change order**, then edit and approve it.
4. Click **Open client page**, and choose pay, swap or defer for each item.
5. Click **Pay with PayPal** and sign in as a sandbox buyer. Test buyer details are in the Devpost testing instructions.
6. Return to the dashboard to see the payment, the updated scope and the ledger.

The hosted demo uses temporary storage. It can take about a minute to wake up, and saved projects can disappear when it restarts, so start again from the sample project if a link stops working.

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

## Safety rules

- **The AI can't move money.** It has no payment tools, and only server code can create an invoice, after approval.
- **The AI can't set prices.** Prices come from approved time and the freelancer's rate, or a price they enter.
- **Citations are checked.** A quote that isn't in the agreement drops the request to "needs clarifying".
- **Client messages are data.** Instructions inside a message are ignored and flagged.
- **Approval covers the exact content.** Any later edit requires a new approval.
- **Payment needs proof.** Status, invoice ID, amount and a transaction ID must all match. A manually marked or partial payment doesn't count.
- **The sandbox is enforced.** The app refuses to run against any other PayPal address, and invoices can only go to sandbox test accounts.

ScopeBill helps with communication and billing. It isn't legal advice, and the agreement still governs.

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

## Test results

**AI test:** one run of 30 sample client messages across 3 different agreements, using `openai/gpt-oss-120b`. Expected answers were written before the run.

| Measure | Result |
|---|---|
| Labels matching the expected answer | 29 of 30 |
| Requests wrongly billed because of an invented quote | 0 |
| Trick messages that changed a label | 0 of 2 |
| Trick messages flagged | 1 of 2 |
| Cost | About $0.003 |

The miss was "Can you design some Instagram post templates to match?". The AI's quote wasn't in the agreement, so the request dropped to "needs clarifying" for the freelancer to review.

This is an internal test written by the author, from a single run. It isn't proof of real-world accuracy.

**Other checks:** run `bun test` for the automated tests. Real sandbox payments have also been completed and confirmed through this flow.

## Run it locally

You need [Bun](https://bun.sh/), a PayPal sandbox app with Invoicing enabled, and an OpenRouter key.

```bash
bun install
```

```bash
cp .env.example .env
```

Fill in `.env`, then run:

```bash
bun run start
```

Open <http://localhost:3000>.

| Command | Purpose |
|---|---|
| `bun test` | Run the automated tests |
| `bun run typecheck` | Check types |
| `bun run ai:eval` | Run the AI test using your OpenRouter credits |

## Deploy to Render

This repo includes a [Dockerfile](Dockerfile) and a [render.yaml](render.yaml) blueprint. In Render, create a new Blueprint from your repo, then enter the values it asks for: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_SANDBOX_BUYER_EMAIL` and `OPENROUTER_API_KEY`.

## Limits

- **Sandbox only:** every payment is a test payment.
- **One seller account:** the demo uses one PayPal sandbox merchant. Connecting many freelancers' accounts isn't built.
- **Messages are pasted in:** the app doesn't watch email or Slack.
- **Time estimates are rough:** they're suggestions for the freelancer to set.
- **Project links are private links:** anyone with a link can open that project. There are no user accounts.

## License

[MIT](LICENSE)
