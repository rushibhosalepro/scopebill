import { loadConfig, PayPalClient, PayPalError } from "../src/paypal/client";

const STATE_FILE = ".invoice-test.json";

const client = new PayPalClient(loadConfig());
const command = process.argv[2];

async function create() {
  const buyer = process.env.PAYPAL_SANDBOX_BUYER_EMAIL?.trim();
  if (!buyer) throw new Error("Set PAYPAL_SANDBOX_BUYER_EMAIL in .env");
  if (!buyer.endsWith(".example.com")) {
    throw new Error("PAYPAL_SANDBOX_BUYER_EMAIL must be a sandbox test account");
  }

  const runId = crypto.randomUUID();
  const draft = await client.createDraftInvoice(
    {
      recipientEmail: buyer,
      currency: "USD",
      note: "ScopeBill sandbox test. No real money is involved.",
      items: [
        {
          name: "Change order: social media kit",
          description: "Sandbox test of an approved scope change",
          quantity: 1,
          unitAmount: "150.00",
        },
      ],
    },
    `create-${runId}`,
  );
  console.log(`Draft created: ${draft.id} (${draft.status}), total ${draft.total} ${draft.currency}`);

  await client.sendInvoice(draft.id, `send-${runId}`);
  const sent = await client.getInvoice(draft.id);
  await Bun.write(STATE_FILE, JSON.stringify({ invoiceId: sent.id }, null, 2));

  console.log(`Sent: status is ${sent.status}`);
  console.log(`Pay as the sandbox buyer here:\n${sent.payerViewUrl ?? "(PayPal returned no payer link)"}`);
}

async function check() {
  const invoiceId = process.argv[3] ?? (await readSavedId());
  const invoice = await client.getInvoice(invoiceId);
  console.log(
    JSON.stringify(
      {
        id: invoice.id,
        status: invoice.status,
        total: invoice.total,
        paidAmount: invoice.paidAmount,
        transactionIds: invoice.transactionIds,
      },
      null,
      2,
    ),
  );
  console.log(invoice.status === "PAID" ? "PASS: PayPal confirms this invoice is paid." : "Not paid yet.");
}

async function readSavedId(): Promise<string> {
  const file = Bun.file(STATE_FILE);
  if (!(await file.exists())) throw new Error("No saved invoice. Run invoice:create first.");
  const { invoiceId } = (await file.json()) as { invoiceId: string };
  return invoiceId;
}

try {
  if (command === "create") await create();
  else if (command === "check") await check();
  else throw new Error("Usage: invoice-test.ts <create|check> [invoiceId]");
} catch (error) {
  if (error instanceof PayPalError) {
    console.error(error.message);
    console.error(`HTTP ${error.status}, debug id: ${error.debugId ?? "none"}`);
    console.error(JSON.stringify(error.details, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
