/**
 * Servidor HTTP — Hono
 * POST /api/chat  { sessionId, message } → SSE con eventos del agente
 * GET  /           → Frontend de chat
 * GET  /api/health → { ok: true }
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { AgentLoop, type AgentEvent } from "./agent/loop.js";
import { resolve } from "path";

const app = new Hono();
const PORT = parseInt(process.env.PORT || "3000");
const PROJECT_DIR = resolve(import.meta.dir, "..");

// ─── Middleware ─────────────────────────────────────────────────────────────

app.use("/api/*", cors());

// ─── Sesiones ───────────────────────────────────────────────────────────────

const sessions = new Map<string, AgentLoop>();

function getOrCreateSession(sessionId: string): AgentLoop {
  let agent = sessions.get(sessionId);
  if (!agent) {
    agent = new AgentLoop({
      directory: PROJECT_DIR,
      sessionId,
    });
    sessions.set(sessionId, agent);
  }
  return agent;
}

// ─── Rutas API ──────────────────────────────────────────────────────────────

app.get("/api/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Chat endpoint — SSE streaming
app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ sessionId?: string; message: string }>();
  const sessionId = body.sessionId || crypto.randomUUID();
  const message = body.message?.trim();

  if (!message) {
    return c.json({ ok: false, error: "El campo 'message' es requerido" }, 400);
  }

  // Verificar API key
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    return c.json({
      ok: false,
      error: "API key no configurada. Configure GEMINI_API_KEY o OPENAI_API_KEY en .env",
    }, 500);
  }

  return streamSSE(c, async (stream) => {
    const agent = getOrCreateSession(sessionId);

    const events: AgentEvent[] = [];

    // Reemplazar el onEvent temporalmente para capturar streaming
    const originalAgent = sessions.get(sessionId)!;

    // Crear un nuevo agente con streaming si es la primera vez
    if (!sessions.has(sessionId + "_initialized")) {
      sessions.delete(sessionId);
      const streamingAgent = new AgentLoop({
        directory: PROJECT_DIR,
        sessionId,
        onEvent: async (event) => {
          await stream.writeSSE({
            data: JSON.stringify(event),
            event: event.type,
          });
        },
      });
      sessions.set(sessionId, streamingAgent);
      sessions.set(sessionId + "_initialized", streamingAgent);
    }

    const activeAgent = sessions.get(sessionId)!;

    try {
      const response = await activeAgent.processMessage(message);

      await stream.writeSSE({
        data: JSON.stringify({
          sessionId,
          response,
          tokensUsados: activeAgent.getTokensUsados(),
        }),
        event: "done",
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        data: JSON.stringify({ error: errMsg }),
        event: "error",
      });
    }
  });
});

// Chat endpoint — simple JSON (sin streaming, para demo)
app.post("/api/chat/simple", async (c) => {
  const body = await c.req.json<{ sessionId?: string; message: string }>();
  const sessionId = body.sessionId || crypto.randomUUID();
  const message = body.message?.trim();

  if (!message) {
    return c.json({ ok: false, error: "El campo 'message' es requerido" }, 400);
  }

  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    return c.json({
      ok: false,
      error: "API key no configurada. Configure GEMINI_API_KEY o OPENAI_API_KEY en .env",
    }, 500);
  }

  const events: AgentEvent[] = [];
  const agent = new AgentLoop({
    directory: PROJECT_DIR,
    sessionId,
    onEvent: (event) => events.push(event),
  });

  try {
    const response = await agent.processMessage(message);
    return c.json({
      ok: true,
      sessionId,
      response,
      events,
      tokensUsados: agent.getTokensUsados(),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: errMsg }, 500);
  }
});

// ─── Frontend estático ─────────────────────────────────────────────────────

app.get("/", async (c) => {
  const html = await Bun.file(resolve(PROJECT_DIR, "public", "index.html")).text();
  return c.html(html);
});

app.use("/public/*", serveStatic({ root: "./" }));

// ─── Inicio ─────────────────────────────────────────────────────────────────

console.log(`🚀 Servidor iniciado en http://localhost:${PORT}`);
console.log(`   Modelo: ${process.env.LLM_MODEL || "gpt-4o-mini"}`);
console.log(`   Proyecto: ${PROJECT_DIR}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
