/**
 * Adaptador LLM — abstrae el proveedor (OpenAI SDK compatible).
 * Interfaz: enviar(mensajes, herramientas) → respuesta
 */
import OpenAI from "openai";

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMResponse {
  content: string | null;
  tool_calls: LLMToolCall[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finish_reason: string;
}

// ─── Adaptador ──────────────────────────────────────────────────────────────

export class LLMAdapter {
  private client: OpenAI;
  private model: string;
  private tokensUsados: number = 0;
  private maxTokensSesion: number;

  constructor(opts?: { apiKey?: string; model?: string; maxTokensSesion?: number; baseURL?: string }) {
    const apiKey = opts?.apiKey || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || "";
    this.model = opts?.model || process.env.LLM_MODEL || "gemini-2.0-flash";
    this.maxTokensSesion = opts?.maxTokensSesion || parseInt(process.env.MAX_TOKENS_PER_SESSION || "100000");

    const baseURL = opts?.baseURL || process.env.LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/";

    this.client = new OpenAI({ apiKey, baseURL });
  }

  get tokensConsumidos(): number {
    return this.tokensUsados;
  }

  get limiteAlcanzado(): boolean {
    return this.tokensUsados >= this.maxTokensSesion;
  }

  async enviar(mensajes: LLMMessage[], herramientas?: LLMToolDef[]): Promise<LLMResponse> {
    if (this.limiteAlcanzado) {
      return {
        content: "⚠️ Se alcanzó el límite de tokens por sesión. Inicie una nueva conversación.",
        tool_calls: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        finish_reason: "stop",
      };
    }

    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: mensajes as OpenAI.ChatCompletionMessageParam[],
      temperature: 0.2,
      max_tokens: 4096,
    };

    if (herramientas && herramientas.length > 0) {
      params.tools = herramientas as OpenAI.ChatCompletionTool[];
      params.tool_choice = "auto";
    }

    const completion = await this.client.chat.completions.create(params);
    const choice = completion.choices[0];
    const usage = completion.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    this.tokensUsados += usage.prompt_tokens + usage.completion_tokens;

    const toolCalls: LLMToolCall[] = (choice.message.tool_calls || []).map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    return {
      content: choice.message.content,
      tool_calls: toolCalls,
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
      },
      finish_reason: choice.finish_reason || "stop",
    };
  }
}
