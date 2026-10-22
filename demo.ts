/**
 * demo.ts — Verificación de herramientas SIN modelo LLM
 * Ejecuta: bun run demo.ts
 *
 * Prueba las 5 herramientas P0 con los 6 mensajes del buzón
 * y verifica que los resultados coincidan con los esperados del PRD.
 */
import { leer_buzon, extraer, validar, registrar, alertas } from "./src/tools/contratos.js";
import { resolve } from "path";
import { rmSync, existsSync } from "fs";

const DIR = resolve(import.meta.dir);
const ctx = { directory: DIR, sessionId: "demo-" + Date.now() };

// Colores para la terminal
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function header(text: string) {
  console.log(`\n${BOLD}${CYAN}${"═".repeat(60)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${text}${RESET}`);
  console.log(`${CYAN}${"═".repeat(60)}${RESET}\n`);
}

function ok(text: string) { console.log(`  ${GREEN}✓${RESET} ${text}`); }
function fail(text: string) { console.log(`  ${RED}✗${RESET} ${text}`); }
function info(text: string) { console.log(`  ${YELLOW}→${RESET} ${text}`); }

let passed = 0;
let failed = 0;

function assert(condition: boolean, desc: string) {
  if (condition) { ok(desc); passed++; }
  else { fail(desc); failed++; }
}

// ─── Limpiar out/ para demo limpia ──────────────────────────────────────────

if (existsSync(resolve(DIR, "out"))) {
  rmSync(resolve(DIR, "out"), { recursive: true });
}

// ─── Test 1: leer_buzon ─────────────────────────────────────────────────────

header("1. contratos_leer_buzon");

const buzonResult = JSON.parse(await leer_buzon.execute({} as any, ctx));
assert(buzonResult.ok === true, "Respuesta ok");
assert(buzonResult.data.total === 6, `Total mensajes: ${buzonResult.data.total} (esperado: 6)`);
assert(buzonResult.data.pendientes === 6, `Pendientes: ${buzonResult.data.pendientes} (esperado: 6)`);

info("Mensajes encontrados:");
for (const m of buzonResult.data.mensajes) {
  info(`  ${m.id}: "${m.asunto}" — contrato: ${m.tiene_contrato}, de: ${m.de}`);
}

// ─── Test 2: extraer — para cada mensaje ────────────────────────────────────

header("2. contratos_extraer");

const extracciones: Record<string, any> = {};

for (const m of buzonResult.data.mensajes) {
  const result = JSON.parse(await extraer.execute({ mensaje_id: m.id }, ctx));
  extracciones[m.id] = result;

  if (result.ok) {
    const c = result.data.contrato;
    info(`${m.id}: id=${c.id_contrato.valor}, cliente=${c.cliente.valor}, valor=${c.valor.valor} ${c.moneda.valor}`);
    if (result.data.es_otrosi) info(`  ↳ Es otrosí del contrato ${result.data.id_contrato_original}`);
  } else {
    info(`${m.id}: ${result.error}`);
  }
}

// msg-005 no debe tener contrato (es cotización)
assert(extracciones["msg-005"].ok === false, "msg-005: No tiene adjunto de contrato (es cotización)");

// msg-001 debe extraer datos completos
assert(extracciones["msg-001"].ok === true, "msg-001: Extracción exitosa");

// msg-003 debe ser otrosí
if (extracciones["msg-003"].ok) {
  assert(extracciones["msg-003"].data.es_otrosi === true, "msg-003: Identificado como otrosí");
}

// ─── Test 3: validar — clasificación ────────────────────────────────────────

header("3. contratos_validar");

interface Expected { clasificacion: string; notes: string }
const esperados: Record<string, Expected> = {
  "msg-001": { clasificacion: "nuevo", notes: "Industrias Delta, COP 265M" },
  "msg-002": { clasificacion: "nuevo", notes: "Corp Andina, USD 120K" },
  "msg-003": { clasificacion: "actualizacion", notes: "Otrosí CT-2026-011" },
  "msg-004": { clasificacion: "duplicado", notes: "CT-2026-012 mismo datos" },
  "msg-005": { clasificacion: "rechazado", notes: "Cotización, no contrato" },
  "msg-006": { clasificacion: "nuevo", notes: "CM-2026-03, valor indeterminado, requiere_revision" },
};

const validaciones: Record<string, any> = {};

for (const m of buzonResult.data.mensajes) {
  const ext = extracciones[m.id];

  if (!ext.ok) {
    // msg-005: validar debe clasificar como rechazado
    const valResult = JSON.parse(await validar.execute({
      mensaje_id: m.id,
      contrato: {},
    }, ctx));
    validaciones[m.id] = valResult;

    if (valResult.ok) {
      const esp = esperados[m.id];
      assert(
        valResult.data.clasificacion === esp.clasificacion,
        `${m.id}: clasificación=${valResult.data.clasificacion} (esperado: ${esp.clasificacion}) — ${esp.notes}`
      );
    }
    continue;
  }

  const contrato = { ...ext.data.contrato, es_otrosi: ext.data.es_otrosi, id_contrato_original: ext.data.id_contrato_original };
  const valResult = JSON.parse(await validar.execute({ mensaje_id: m.id, contrato }, ctx));
  validaciones[m.id] = valResult;

  if (valResult.ok) {
    const esp = esperados[m.id];
    assert(
      valResult.data.clasificacion === esp.clasificacion,
      `${m.id}: clasificación=${valResult.data.clasificacion} (esperado: ${esp.clasificacion}) — ${esp.notes}`
    );

    if (valResult.data.requiere_revision?.length > 0) {
      info(`  ⚠️  Requiere revisión: ${valResult.data.requiere_revision.join(", ")}`);
    }
    if (valResult.data.diferencias) {
      info(`  Diferencias: ${JSON.stringify(valResult.data.diferencias)}`);
    }
  } else {
    fail(`${m.id}: Error en validación — ${valResult.error}`);
    failed++;
  }
}

// msg-006 debe tener requiere_revision
if (validaciones["msg-006"]?.ok) {
  assert(
    validaciones["msg-006"].data.requiere_revision?.length > 0,
    "msg-006: Tiene campos en requiere_revision (valor indeterminado, comercial desconocido)"
  );
}

// ─── Test 4: registrar ──────────────────────────────────────────────────────

header("4. contratos_registrar");

// Registrar msg-001 (nuevo, sin revisión)
if (extracciones["msg-001"]?.ok) {
  const c = { ...extracciones["msg-001"].data.contrato, es_otrosi: false };
  const regResult = JSON.parse(await registrar.execute({ mensaje_id: "msg-001", contrato: c, confirmado: true }, ctx));
  assert(regResult.ok === true, "msg-001: Registro exitoso");
  if (regResult.ok) {
    info(`  ID: ${regResult.data.id_contrato}, Acción: ${regResult.data.accion}`);
  }
}

// Registrar msg-004 (duplicado — no debe escribir)
if (extracciones["msg-004"]?.ok) {
  const c = { ...extracciones["msg-004"].data.contrato, es_otrosi: false };
  const regResult = JSON.parse(await registrar.execute({ mensaje_id: "msg-004", contrato: c }, ctx));
  assert(regResult.ok === true && regResult.data.clasificacion === "duplicado", "msg-004: Detectado como duplicado, no registrado");
}

// Registrar msg-003 (actualización otrosí)
if (extracciones["msg-003"]?.ok) {
  const c = { ...extracciones["msg-003"].data.contrato, es_otrosi: true, id_contrato_original: extracciones["msg-003"].data.id_contrato_original };
  const regResult = JSON.parse(await registrar.execute({ mensaje_id: "msg-003", contrato: c, confirmado: true }, ctx));
  assert(regResult.ok === true, "msg-003: Actualización (otrosí) registrada");
  if (regResult.ok) {
    info(`  Acción: ${regResult.data.accion}, Diferencias: ${JSON.stringify(regResult.data.diferencias)}`);
  }
}

// Registrar msg-006 sin confirmación (debe fallar por requiere_revision)
if (extracciones["msg-006"]?.ok) {
  const c = { ...extracciones["msg-006"].data.contrato, es_otrosi: false };
  const regResult = JSON.parse(await registrar.execute({ mensaje_id: "msg-006", contrato: c }, ctx));
  assert(regResult.ok === false, "msg-006: Rechazado sin confirmación (requiere_revision)");

  // Ahora con confirmación
  const regResult2 = JSON.parse(await registrar.execute({ mensaje_id: "msg-006", contrato: c, confirmado: true }, ctx));
  assert(regResult2.ok === true, "msg-006: Registro exitoso con confirmación forzada");
}

// ─── Test 5: alertas ────────────────────────────────────────────────────────

header("5. contratos_alertas");

const alertasResult = JSON.parse(await alertas.execute({ hoy: "2026-09-15" }, ctx));
assert(alertasResult.ok === true, "Reporte de alertas generado");
info(`Vencen en ≤60 días: ${alertasResult.data.vencen.length}`);
info(`Pólizas pendientes: ${alertasResult.data.polizas_pendientes.length}`);
info(`Registrados desde corte: ${alertasResult.data.registrados_desde_corte.length}`);
info(`Ruta: ${alertasResult.data.ruta}`);

// ─── Resumen ────────────────────────────────────────────────────────────────

header("RESUMEN");

console.log(`  ${GREEN}${passed} tests pasaron${RESET}`);
if (failed > 0) console.log(`  ${RED}${failed} tests fallaron${RESET}`);
else console.log(`  ${GREEN}¡Todos los tests pasaron!${RESET}`);

console.log(`\n  Archivos generados en out/:`);

import { readdirSync, statSync } from "fs";

function listDir(dir: string, prefix = "  ") {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      console.log(`${prefix}📁 ${entry}/`);
      listDir(full, prefix + "  ");
    } else {
      console.log(`${prefix}📄 ${entry} (${stat.size} bytes)`);
    }
  }
}

listDir(resolve(DIR, "out"));

process.exit(failed > 0 ? 1 : 0);
