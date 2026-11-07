/** A broken business rule, as opposed to an unexpected failure. */
export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

export type ScopeItemKind = "deliverable" | "limit" | "exclusion";

export interface ScopeItem {
  id: string;
  kind: ScopeItemKind;
  text: string;
  sourceQuote: string;
  priceCents?: number;
}

export type RequestLabel = "in_scope" | "out_of_scope" | "needs_clarifying";

export interface ClientRequest {
  id: string;
  text: string;
  receivedAt: string;
  label: RequestLabel;
  citedQuotes: string[];
  minutes: number;
  billedInOrderId?: string;
}

export interface UnbilledTotal {
  requestCount: number;
  minutes: number;
  amountCents: number;
}

export function priceForMinutes(minutes: number, hourlyRateCents: number): number {
  assertWhole(minutes, "minutes");
  assertWhole(hourlyRateCents, "hourlyRateCents");
  return Math.round((minutes * hourlyRateCents) / 60);
}

export function unbilledTotal(requests: ClientRequest[], hourlyRateCents: number): UnbilledTotal {
  const open = requests.filter((r) => r.label === "out_of_scope" && !r.billedInOrderId);
  const minutes = open.reduce((sum, r) => sum + r.minutes, 0);
  return {
    requestCount: open.length,
    minutes,
    amountCents: priceForMinutes(minutes, hourlyRateCents),
  };
}

export function invalidCitations(citedQuotes: string[], agreement: string): string[] {
  const source = normalize(agreement);
  return citedQuotes.filter((quote) => {
    const cited = normalize(quote);
    return cited.length === 0 || !source.includes(cited);
  });
}

function normalize(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function assertWhole(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RuleError(`${name} must be a whole number of 0 or more`);
  }
}
