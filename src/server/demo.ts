import type { RequestLabel, ScopeItem } from "../core/scope";

export const DEMO_AGREEMENT = `Project: Website landing page for Lumen Coffee.

Deliverables:
1. One responsive landing page with up to 5 sections.
2. Copy edits to text supplied by the client.
3. A contact form that sends messages to the client's email address.

Revisions: 2 rounds of revisions are included.

Not included: logo design, a blog, search engine optimization (SEO), paid advertising and hosting.

Extra work is billed at $100 per hour after written approval.`;

export const DEMO_SCOPE: Array<Omit<ScopeItem, "id">> = [
  {
    kind: "deliverable",
    text: "One responsive landing page with up to 5 sections",
    sourceQuote: "One responsive landing page with up to 5 sections.",
    priceCents: 120_000,
  },
  {
    kind: "deliverable",
    text: "Copy edits to text supplied by the client",
    sourceQuote: "Copy edits to text supplied by the client.",
  },
  {
    kind: "deliverable",
    text: "Contact form that emails the client",
    sourceQuote: "A contact form that sends messages to the client's email address.",
    priceCents: 15_000,
  },
  { kind: "limit", text: "2 rounds of revisions", sourceQuote: "2 rounds of revisions are included." },
  {
    kind: "exclusion",
    text: "Logo design, blog, SEO, paid advertising and hosting",
    sourceQuote: "Not included: logo design, a blog, search engine optimization (SEO), paid advertising and hosting.",
  },
];

export const DEMO_REQUESTS: Array<{
  text: string;
  label: RequestLabel;
  reason: string;
  citedQuotes: string[];
  minutes: number;
}> = [
  {
    text: "Can you fix the typo in the hero heading I sent you?",
    label: "in_scope",
    reason: "Correcting client-supplied text is a listed copy edit.",
    citedQuotes: ["Copy edits to text supplied by the client."],
    minutes: 0,
  },
  {
    text: "Can you also add a simple newsletter signup?",
    label: "out_of_scope",
    reason: "A newsletter signup isn't among the listed deliverables.",
    citedQuotes: ["One responsive landing page with up to 5 sections."],
    minutes: 45,
  },
  {
    text: "Could you make a version of the hero for Instagram?",
    label: "out_of_scope",
    reason: "Social media graphics aren't among the listed deliverables.",
    citedQuotes: ["One responsive landing page with up to 5 sections."],
    minutes: 30,
  },
  {
    text: "Can you add online table booking?",
    label: "out_of_scope",
    reason: "A booking system isn't among the listed deliverables.",
    citedQuotes: ["One responsive landing page with up to 5 sections."],
    minutes: 180,
  },
  {
    text: "While you're at it, could you design a new logo?",
    label: "out_of_scope",
    reason: "The agreement specifically excludes logo design.",
    citedQuotes: ["Not included: logo design"],
    minutes: 240,
  },
  {
    text: "Can you make it pop a bit more?",
    label: "needs_clarifying",
    reason: "This doesn't say what work is being requested.",
    citedQuotes: [],
    minutes: 0,
  },
];
