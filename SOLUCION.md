# SOLUCIÓN — Reto 02: Registro de Contratos Vigentes

## 1. Problema en una frase

Los contratos firmados no llegan al maestro de SharePoint porque no existe un proceso automático de captura desde el buzón de correo, generando un gap de facturación que afecta directamente al área financiera y a los comerciales que pierden visibilidad sobre vencimientos y pólizas.

## 2. Arquitectura

```
┌──────────────┐     POST /api/chat     ┌──────────────────┐
│   Frontend   │ ──────────────────────▶ │   Hono Server    │
│  (HTML/JS)   │ ◀────────────────────── │   src/server.ts  │
└──────────────┘     JSON response       └────────┬─────────┘
                                                  │
                                         ┌────────▼─────────┐
                                         │   Agent Loop     │
                                         │ src/agent/loop.ts│
                                         └────────┬─────────┘
                                                  │
                              ┌────────────────────┼────────────────────┐
                              │                    │                    │
                    ┌─────────▼────────┐  ┌───────▼────────┐  ┌───────▼────────┐
                    │ Comportamiento   │  │  Conocimiento  │  │   Ejecución    │
                    │ agent/prompt.md  │  │ src/knowledge/ │  │  src/tools/    │
                    │ (system prompt)  │  │ (reglas, datos)│  │ contratos.ts   │
                    └──────────────────┘  └────────────────┘  └───────┬────────┘
                                                                      │
                                         ┌────────────────────────────┼──────┐
                                         │          Archivos                 │
                                         │                                   │
                                    fixtures/reto-02/          out/sharepoint/
                                    ├─ buzon/                  ├─ maestro-contratos.csv
                                    ├─ maestro-contratos.csv   ├─ historial.jsonl
                                    └─ comerciales.json        └─ Contratos/{año}/{cliente}/
```

**Separación de concerns:**
- **Comportamiento** → `agent/prompt.md`: define cómo el agente interactúa, su flujo de trabajo y reglas de presentación. Cambiar el tono o el idioma no toca código.
- **Conocimiento** → `src/knowledge/` + `fixtures/`: datos maestros, comerciales, reglas de negocio codificadas en las herramientas.
- **Ejecución** → `src/tools/contratos.ts`: 5 herramientas P0 que manipulan archivos. Nunca ejecutan shell.

## 3. Ciclo del agente

El agente implementa un bucle clásico ReAct:

1. **Recibe mensaje** del usuario → lo agrega al historial
2. **Envía historial + herramientas** al LLM
3. **Si el LLM responde con tool_calls** → ejecuta cada herramienta, agrega resultados al historial, vuelve al paso 2
4. **Si el LLM responde con texto** → es la respuesta final, se entrega al usuario
5. **Guardias**: tope de 25 iteraciones por turno y 100K tokens por sesión (configurables vía env)

**Confirmación humana:** cuando `contratos_validar` detecta campos con confianza < 0.8 (`requiere_revision`), el agente presenta los datos al usuario y pregunta antes de registrar. Solo si el usuario confirma, se llama `contratos_registrar` con `confirmado: true`.

## 4. Elección del modelo

| Aspecto | Decisión |
|---|---|
| Proveedor | OpenAI (SDK oficial) |
| Modelo | `gpt-4o-mini` (por defecto, configurable) |
| Razón | Equilibrio costo/calidad para tool calling. Soporta function calling nativo. Es el más económico que maneja bien herramientas estructuradas. |
| Costo estimado | ~$0.003 USD por caso procesado (prompt ~2K tokens input + ~500 output × 3-4 iteraciones) |
| Adaptabilidad | El adaptador usa OpenAI SDK, compatible con cualquier proveedor que implemente la misma API (Azure OpenAI, Groq, Together, etc.) |

## 5. Estrategia de extracción

La extracción es **determinista** (regex + heurísticas), no depende del LLM:

| Campo | Método | Confianza |
|---|---|---|
| `id_contrato` | Regex: `No. CT-XXXX-XXX` o `CM-XXXX-XX` | 1.0 si match, 0 si no |
| `cliente` | Regex: nombre + tipo societario (S.A.S., S.A., S.A.C.) excluyendo Periferia | 1.0 si match |
| `nit_cliente` | Regex: `NIT/RUC/RTN` + dígitos, excluyendo NIT de Periferia | 1.0 si match |
| `pais` | Inferido de tipo de documento (NIT→CO, RUC→PE/EC) + contexto textual | 0.9 |
| `valor` | Regex: moneda + cifra, con parsing inteligente de separadores (265.000.000 vs 520,000.00) | 1.0 normal, 0.5 si "indeterminado" |
| `fechas` | Regex: "desde/hasta el X de MONTH de YYYY" + derivación por plazo en meses | 1.0 explícita, 0.6 derivada |
| `póliza` | Detección de keywords: cumplimiento, calidad, responsabilidad civil | 0.9 |

**Dónde entra el LLM:** el LLM orquesta el flujo (decide qué herramienta llamar, presenta resultados, pide confirmación), pero **no extrae datos**. Toda extracción es determinista y reproducible.

## 6. Regla de gobierno propuesta

### Canal único
El buzón `contratos@periferia-ficticia.com` es el canal exclusivo para recibir contratos. Es administrado por el área de Operaciones con backup en el líder del proyecto de automatización.

### Obligación del comercial
El comercial debe enviar al buzón, dentro de las **48 horas hábiles** posteriores a la firma:
- PDF firmado del contrato (o `.txt` en el piloto)
- Otrosíes como documentos separados referenciando el contrato original en el asunto
- Actas de terminación cuando aplique

**Formato de asunto obligatorio:** `[CONTRATO] {ID} - {Cliente} - {Objeto breve}` o `[OTROSÍ] {ID original} - {Cliente}`

### Acuse automático
El agente responde al comercial en máximo **5 minutos** con:
- Confirmación de recepción y número de contrato asignado
- Clasificación aplicada (nuevo / actualización)
- Lista de campos en revisión, si los hay
- Aviso de que se escalará si requiere intervención humana

### Excepciones y escalamiento
- **Sin firma:** se registra como `borrador` y se notifica al líder comercial
- **Sin valor:** se registra con valor 0 y `requiere_revision`, se escala al gerente de cuenta
- **Remitente desconocido:** se registra pero se marca para validación manual
- **Escalamiento:** correo automático al coordinador de contratos + Slack al canal #contratos-alertas

### Cierre del gap (junio–agosto 2026)
Campaña de 2 semanas:
1. Cada comercial envía los contratos de su cartera pendientes al buzón con asunto `[RECUPERACIÓN] {ID}`
2. El agente los procesa en modo batch, priorizando por fecha de vencimiento
3. Se genera un reporte de cobertura comparando contratos facturados vs. registrados

### Indicador mensual
**% de cobertura del maestro** = (Contratos en maestro con factura activa / Total de contratos facturados en el periodo) × 100. Meta: ≥ 95% a partir del tercer mes.

## 7. Decisiones y trade-offs

### 1. Extracción determinista vs. LLM
- **Elegido:** Regex + heurísticas para extraer campos
- **Descartado:** Usar el LLM para extraer datos del contrato
- **Razón:** Reproducibilidad. `demo.ts` debe dar el mismo resultado siempre. Si el LLM extrae, dos ejecuciones pueden dar valores diferentes. Además, el costo baja y el determinismo sube.

### 2. CSV como maestro vs. base de datos
- **Elegido:** CSV mutable copiado a `out/`
- **Descartado:** SQLite o PostgreSQL
- **Razón:** El PRD especifica CSV como formato del maestro. Usar una DB agrega complejidad sin beneficio para el scope del reto. En producción sería una DB relacional.

### 3. Hono + Bun vs. Express + Node
- **Elegido:** Hono con Bun runtime
- **Descartado:** Express con Node.js
- **Razón:** Hono es más ligero, tiene tipado nativo de TypeScript, SSE integrado, y Bun es más rápido para arranque. Compatible con Node 20+ si se necesita.

### 4. Frontend inline vs. framework
- **Elegido:** HTML/CSS/JS vanilla en un solo archivo
- **Descartado:** React, Vue, etc.
- **Razón:** El PRD pide un chat funcional, no una SPA compleja. Un archivo HTML sin build step es más simple de desplegar y mantener.

## 8. Supuestos

1. Los contratos llegan como texto plano (`.txt`), no como PDF. En producción se necesitaría OCR.
2. El formato de contrato sigue una estructura semi-estándar (cláusulas numeradas, datos de las partes al inicio).
3. El maestro CSV inicial es la fuente de verdad al momento del corte (2026-05-30).
4. Los comerciales autorizados están en `comerciales.json` y no cambian durante una sesión.
5. Las monedas soportadas son: COP, USD, PEN (las que aparecen en los fixtures).
6. Un otrosí siempre referencia un contrato existente por su ID.
7. El `nit_cliente` de Periferia (900.123.456-7) es fijo y se usa para excluirlo de la extracción del NIT del cliente.

## 9. Cobertura

| Historia de usuario | Estado | Notas |
|---|---|---|
| Leer buzón y listar mensajes | ✅ Hecho | 6 mensajes, detecta adjuntos |
| Extraer datos con confianza | ✅ Hecho | Regex para todos los campos, confianza por campo |
| Clasificar: nuevo | ✅ Hecho | msg-001, msg-002, msg-006 |
| Clasificar: actualización (otrosí) | ✅ Hecho | msg-003 contra CT-2026-011 |
| Clasificar: duplicado | ✅ Hecho | msg-004 = CT-2026-012 |
| Clasificar: rechazado | ✅ Hecho | msg-005 (cotización) |
| Requiere revisión (confianza < 0.8) | ✅ Hecho | msg-006: valor, fechas, comercial |
| Registrar contrato nuevo | ✅ Hecho | Escribe CSV + archiva documento |
| Actualizar contrato (otrosí) | ✅ Hecho | Modifica valor y fecha_fin |
| No registrar duplicado | ✅ Hecho | Retorna clasificación sin escritura |
| Confirmación humana | ✅ Hecho | Rechaza sin `confirmado=true` si hay revisión |
| Generar alertas | ✅ Hecho | Vencimientos 60 días, pólizas pendientes |
| Archivar documentos | ✅ Hecho | `out/sharepoint/Contratos/{año}/{cliente}/` |
| Historial de operaciones | ✅ Hecho | `historial.jsonl` |
| Chat conversacional con agente | ✅ Hecho | Frontend HTML + API + ciclo agente |
| demo.ts sin modelo | ✅ Hecho | 19 tests, todos pasan |
| Tope de iteraciones | ✅ Hecho | MAX_ITERATIONS configurable |
| Tope de tokens por sesión | ✅ Hecho | MAX_TOKENS_PER_SESSION configurable |

**Faltaría para producción:**
- OCR para contratos escaneados
- Base de datos relacional
- Autenticación y autorización
- Cola de mensajes para procesamiento asíncrono
- Integración real con Exchange/Gmail
- Integración real con SharePoint API
- Tests automatizados con cobertura
- CI/CD pipeline

## 10. Uso de IA

| Asistente | Tarea | Qué descarté |
|---|---|---|
| Claude (Anthropic) | Scaffolding del proyecto, implementación de herramientas, ciclo del agente, frontend, demo.ts, documentación | Sugerencias de usar librerías adicionales (cheerio para parsing); preferí regex puro por simplicidad |
| — | Revisión de regex para extracción de datos | Propuestas de regex excesivamente complejas; simplifiqué para legibilidad |
| — | Estructura de SOLUCION.md | — |

## 11. Riesgos para producción

| Riesgo | Mitigación |
|---|---|
| **Falsos duplicados** por variaciones en nombre del cliente | Deduplicar por `nit_cliente` primero, nombre como fallback con similaridad ≥ 0.9 |
| **Valores mal parseados** por formatos regionales (1.234,56 vs 1,234.56) | Detección automática de formato por patrón; validación humana obligatoria si la diferencia con el maestro es > 20% |
| **Contratos escaneados** sin texto extraíble | Integrar OCR (Azure Document Intelligence / AWS Textract) antes de la extracción |
| **Modelo "alucina"** un valor o fecha | El modelo NO extrae datos; solo orquesta. Los valores vienen de las herramientas deterministas |
| **Clave del modelo expuesta** | Solo en variable de entorno del backend. Nunca en frontend, logs, respuestas API ni repositorio |
| **Costo descontrolado** | Tope de iteraciones (25) y tokens por sesión (100K) configurables. Un usuario no puede gastar sin límite |
| **Un caso malo bloquea los siguientes** | Las herramientas nunca lanzan excepciones; retornan `{ ok: false, error }`. Cada mensaje se procesa independientemente |
