const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
}

export interface JsonRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface JsonResponse<T> {
  data: T;
  model: string;
  usage: Usage;
}

export interface JsonModel {
  completeJson<T>(request: JsonRequest): Promise<JsonResponse<T>>;
}

export class OpenRouterError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "OpenRouterError";
  }
}

class BadOutput extends OpenRouterError {}

export class OpenRouterClient implements JsonModel {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!apiKey) throw new Error("Set OPENROUTER_API_KEY in .env");
    if (!model) throw new Error("Set OPENROUTER_MODEL in .env");
  }

  async completeJson<T>(request: JsonRequest): Promise<JsonResponse<T>> {
    try {
      return await this.attempt<T>(request);
    } catch (error) {
      if (error instanceof BadOutput) return this.attempt<T>(request);
      throw error;
    }
  }

  private async attempt<T>(request: JsonRequest): Promise<JsonResponse<T>> {
    const response = await this.fetcher(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "ScopeBill",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: request.maxTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: request.schemaName, strict: true, schema: request.schema },
        },
        provider: { require_parameters: true, data_collection: "deny" },
        usage: { include: true },
      }),
    });

    const body = (await response.json().catch(() => null)) as RawResponse | null;
    if (!response.ok || body?.error) {
      throw new OpenRouterError(
        `OpenRouter request failed: ${body?.error?.message ?? response.statusText}`,
        body?.error?.code ?? response.status,
      );
    }

    const content = body?.choices?.[0]?.message?.content;
    if (!content) throw new BadOutput("The model returned no content", response.status);

    let data: T;
    try {
      data = JSON.parse(content) as T;
    } catch {
      throw new BadOutput("The model returned invalid JSON", response.status);
    }

    return {
      data,
      model: body?.model ?? this.model,
      usage: {
        promptTokens: body?.usage?.prompt_tokens ?? 0,
        completionTokens: body?.usage?.completion_tokens ?? 0,
        costUsd: body?.usage?.cost ?? null,
      },
    };
  }
}

export function openRouterFromEnv(
  env: Record<string, string | undefined> = process.env,
  model?: string,
): OpenRouterClient {
  return new OpenRouterClient(
    env.OPENROUTER_API_KEY?.trim() ?? "",
    model ?? env.OPENROUTER_MODEL?.trim() ?? "",
  );
}

interface RawResponse {
  model?: string;
  error?: { message?: string; code?: number };
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}
