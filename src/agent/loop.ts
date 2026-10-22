/**
 * Ciclo del agente conversacional.
 * prompt → modelo → tool_calls → execute → respuesta
 */
import { LLMAdapter, type LLMMessage, type LLMToolDef, type LLMToolCall } from "../llm/adapter.js";
import { leer_buzon, extraer, validar, registrar, alertas } from "../tools/contratos.js";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

// ─── Tipos ──────────────────────────────────────────────────────────────────

interface ToolRegistry {
  [name: string]: {
    description: string;
    args: Record<string, z.ZodType>;
    execute: (args: any, ctx: ToolContext) => Promise<string>;
  };
}

interface ToolContext {
  directory: string;
  sessionId: string;
}

export interface AgentEvent {
  type: "thinking" | "tool_call" | "tool_result" | "response" | "error" | "limit";
  data: unknown;
}

// ─── Registro de herramientas ───────────────────────────────────────────────

const TOOLS: ToolRegistry = {
  contratos_leer_buzon: leer_buzon,
  contratos_extraer: extraer,
  contratos_validar: validar,
  contratos_registrar: registrar,
  contratos_alertas: alertas,
};

function zodToJsonSchema(schema: Record<string, z.ZodType>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, zodType] of Object.entries(schema)) {
    const desc = (zodType as any)._def?.description || "";
    let type = "string";

    if (zodType instanceof z.ZodBoolean) type = "boolean";
    else if (zodType instanceof z.ZodNumber) type = "number";
    else if (zodType instanceof z.ZodOptional) {
      // Optional — no agregar a required
      const inner = (zodType as any)._def?.innerType;
      if (inner instanceof z.ZodBoolean) type = "boolean";
      else if (inner instanceof z.ZodNumber) type = "number";
      properties[key] = { type, description: desc || (inner as any)?._def?.description || "" };
      continue;
    }

    properties[key] = { type, description: desc };
    if (!(zodType instanceof z.ZodOptional)) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function buildToolDefs(): LLMToolDef[] {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    type: "function" as const,
    function: {
      name,
      description: tool.description,
      parameters: Object.keys(tool.args).length > 0
        ? zodToJsonSchema(tool.args)
        : { type: "object", properties: {} },
    },
  }));
}

// ─── System prompt ──────────────────────────────────────────────────────────

function loadSystemPrompt(directory: string): string {
  try {
    return readFileSync(join(directory, "agent", "prompt.md"), "utf-8");
  } catch {
    return `Eres un asistente experto en gestión de contratos para Periferia IT Group.

Tu trabajo es procesar los correos del buzón, extraer datos de contratos, validarlos contra el maestro vigente, y registrarlos cuando corresponda.

Herramientas disponibles:
- contratos_leer_buzon: Lista mensajes pendientes del buzón
- contratos_extraer: Extrae datos estructurados de un contrato adjunto
- contratos_validar: Clasifica un contrato (nuevo/actualización/duplicado/rechazado)
- contratos_registrar: Registra o actualiza un contrato en el maestro
- contratos_alertas: Genera reporte de alertas de vencimientos y pólizas

Reglas:
1. Siempre lee el buzón primero para saber qué mensajes hay
2. Procesa cada mensaje en orden
3. Antes de registrar, muestra al usuario los datos extraídos y la clasificación
4. Si hay campos con baja confianza (requiere_revision), pregunta al usuario antes de registrar
5. Nunca registres un duplicado
6. Responde siempre en español
7. Sé conciso y profesional`;
  }
}

// ─── Ciclo del agente ───────────────────────────────────────────────────────

export class AgentLoop {
  private llm: LLMAdapter;
  private history: LLMMessage[] = [];
  private toolDefs: LLMToolDef[];
  private ctx: ToolContext;
  private maxIterations: number;
  private onEvent?: (event: AgentEvent) => void;

  constructor(opts: {
    directory: string;
    sessionId: string;
    llm?: LLMAdapter;
    maxIterations?: number;
    onEvent?: (event: AgentEvent) => void;
  }) {
    this.llm = opts.llm || new LLMAdapter();
    this.ctx = { directory: opts.directory, sessionId: opts.sessionId };
    this.maxIterations = opts.maxIterations || parseInt(process.env.MAX_ITERATIONS || "25");
    this.toolDefs = buildToolDefs();
    this.onEvent = opts.onEvent;

    // System prompt
    const systemPrompt = loadSystemPrompt(opts.directory);
    this.history.push({ role: "system", content: systemPrompt });
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  async processMessage(userMessage: string): Promise<string> {
    this.history.push({ role: "user", content: userMessage });

    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations++;

      if (this.llm.limiteAlcanzado) {
        const msg = "⚠️ Se alcanzó el límite de tokens por sesión.";
        this.emit({ type: "limit", data: { tokensUsados: this.llm.tokensConsumidos } });
        return msg;
      }

      let response;
      try {
        response = await this.llm.enviar(this.history, this.toolDefs);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.emit({ type: "error", data: { error: errMsg } });
        return `Error al comunicarme con el modelo: ${errMsg}`;
      }

      // Si no hay tool_calls, es la respuesta final
      if (response.tool_calls.length === 0) {
        const text = response.content || "(sin respuesta)";
        this.history.push({ role: "assistant", content: text });
        this.emit({ type: "response", data: { content: text, usage: response.usage } });
        return text;
      }

      // Hay tool_calls → ejecutar
      const assistantMsg: LLMMessage = {
        role: "assistant",
        content: response.content || "",
        tool_calls: response.tool_calls,
      };
      this.history.push(assistantMsg);

      for (const tc of response.tool_calls) {
        this.emit({ type: "tool_call", data: { name: tc.function.name, arguments: tc.function.arguments } });

        const tool = TOOLS[tc.function.name];
        let result: string;

        if (!tool) {
          result = JSON.stringify({ ok: false, error: `Herramienta "${tc.function.name}" no encontrada` });
        } else {
          try {
            const args = JSON.parse(tc.function.arguments);

            // Validar con Zod si hay schema
            if (Object.keys(tool.args).length > 0) {
              const schema = z.object(tool.args as any);
              schema.parse(args);
            }

            result = await tool.execute(args, this.ctx);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            result = JSON.stringify({ ok: false, error: `Error ejecutando ${tc.function.name}: ${errMsg}` });
          }
        }

        this.emit({ type: "tool_result", data: { tool_call_id: tc.id, name: tc.function.name, result } });

        this.history.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    const msg = `⚠️ Se alcanzó el límite de iteraciones (${this.maxIterations}). La operación se detuvo para evitar bucles infinitos.`;
    this.emit({ type: "limit", data: { iterations: this.maxIterations } });
    return msg;
  }

  getHistory(): LLMMessage[] {
    return [...this.history];
  }

  getTokensUsados(): number {
    return this.llm.tokensConsumidos;
  }
}
