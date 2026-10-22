# Reto 02 — Registro de Contratos Vigentes

Agente conversacional para automatizar el registro de contratos desde un buzón de correo electrónico.

## Levantar en local

```bash
# 1. Instalar dependencias
bun install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env y agregar su OPENAI_API_KEY

# 3. Iniciar servidor
bun run dev
# → http://localhost:3000
```

## Variables de entorno

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `OPENAI_API_KEY` | Sí (para chat) | — | Clave de API de OpenAI |
| `LLM_MODEL` | No | `gpt-4o-mini` | Modelo a utilizar |
| `PORT` | No | `3000` | Puerto del servidor |
| `MAX_ITERATIONS` | No | `25` | Tope de iteraciones por turno |
| `MAX_TOKENS_PER_SESSION` | No | `100000` | Tope de tokens por sesión |

## Ejecutar demo.ts (sin modelo)

```bash
bun run demo.ts
```

Procesa los 6 mensajes del buzón usando solo las herramientas, sin llamar a ningún LLM. Verifica clasificación, extracción y registro.

## Link de prueba

> **https://reto-02-registro-contratos-w47q.onrender.com/**

## Estructura del proyecto

```
reto-02/
├── agent/prompt.md          # System prompt del agente
├── demo.ts                  # Verificación sin modelo
├── fixtures/reto-02/        # Datos de prueba (read-only)
│   ├── buzon/               # 6 mensajes de correo
│   ├── maestro-contratos.csv
│   └── comerciales.json
├── public/index.html         # Frontend de chat
├── src/
│   ├── agent/loop.ts         # Ciclo del agente
│   ├── llm/adapter.ts        # Adaptador LLM (OpenAI SDK)
│   ├── server.ts             # Servidor Hono
│   └── tools/contratos.ts    # 5 herramientas P0
├── SOLUCION.md               # Documentación de la solución
└── package.json
```
