// OpenAI-compatible chat completions client (llama-server, Ollama, vLLM, OpenAI).
// Disables prefix caching (`cache_prompt: false`) so prompt prefixes never leak across companies.

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LlmTool {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface LlmRequest {
  signal?: AbortSignal;
  messages: LlmMessage[];
  tools?: LlmTool[];
  /** Strict JSON schema enforced on completion (`response_format: json_schema`). */
  schema?: { name: string; schema: object };
}

export interface LlmResponse {
  content: string | null;
  tool_calls?: LlmToolCall[];
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface LlmConfig {
  /** Base OpenAI-compatible URL, e.g. `http://localhost:8080/v1` or `http://localhost:11434/v1`. */
  url: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class LlmError extends Error {}

export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const url = env.AUTO_LLM_URL?.trim();
  if (!url) return null;
  return {
    url,
    model: env.AUTO_LLM_MODEL?.trim() || undefined,
    apiKey: env.AUTO_LLM_KEY?.trim() || undefined,
    timeoutMs: env.AUTO_LLM_TIMEOUT_MS ? Number(env.AUTO_LLM_TIMEOUT_MS) : undefined,
  };
}

export function openAiClient(config: LlmConfig, fetcher: typeof fetch = fetch): LlmClient {
  const endpoint = `${config.url.replace(/\/+$/, "")}/chat/completions`;
  return {
    async complete(request) {
      const body = {
        model: config.model ?? "local",
        messages: request.messages,
        temperature: 0,
        cache_prompt: false,
        ...(request.tools?.length ? { tools: request.tools, tool_choice: "auto" } : {}),
        ...(request.schema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: request.schema.name, strict: true, schema: request.schema.schema },
              },
            }
          : {}),
      };
      const res = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs ?? 120_000)])
          : AbortSignal.timeout(config.timeoutMs ?? 120_000),
      });
      if (!res.ok) throw new LlmError(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const payload = (await res.json()) as { choices?: { message?: LlmResponse }[] };
      const message = payload.choices?.[0]?.message;
      if (!message) throw new LlmError("LLM returned an empty choice");
      return {
        content: message.content ?? null,
        tool_calls: message.tool_calls?.length ? message.tool_calls : undefined,
      };
    },
  };
}
