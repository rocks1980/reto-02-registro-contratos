import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, appendFileSync } from "fs";
import { join, resolve, dirname } from "path";

// ─── Tipos ──────────────────────────────────────────────────────────────────

interface ToolContext {
  directory: string;
  sessionId: string;
}

interface Mensaje {
  id: string;
  de: string;
  para: string;
  asunto: string;
  fecha: string;
  cuerpo: string;
  adjuntos: string[];
  tiene_contrato: boolean;
}

interface CampoConfianza {
  valor: string | number | boolean | null;
  confianza: number;
}

interface ContratoExtraido {
  id_contrato: CampoConfianza;
  cliente: CampoConfianza;
  nit_cliente: CampoConfianza;
  pais: CampoConfianza;
  objeto: CampoConfianza;
  valor: CampoConfianza;
  moneda: CampoConfianza;
  fecha_inicio: CampoConfianza;
  fecha_fin: CampoConfianza;
  requiere_poliza: CampoConfianza;
  tipo_poliza: CampoConfianza;
  estado_poliza: CampoConfianza;
}

interface Comercial {
  email: string;
  nombre: string;
  region: string;
}

interface MaestroRow {
  id_contrato: string;
  cliente: string;
  nit_cliente: string;
  pais: string;
  objeto: string;
  valor: string;
  moneda: string;
  fecha_inicio: string;
  fecha_fin: string;
  requiere_poliza: string;
  tipo_poliza: string;
  estado_poliza: string;
  comercial: string;
  ruta_sharepoint: string;
  fecha_registro: string;
  fuente: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureOutDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function fixturePath(ctx: ToolContext, ...segments: string[]): string {
  return join(ctx.directory, "fixtures", "reto-02", ...segments);
}

function outPath(ctx: ToolContext, ...segments: string[]): string {
  const p = join(ctx.directory, "out", ...segments);
  ensureOutDir(dirname(p));
  return p;
}

function logEntry(ctx: ToolContext, entry: Record<string, unknown>): void {
  const p = outPath(ctx, "log.jsonl");
  appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function loadProcesados(ctx: ToolContext): string[] {
  const p = outPath(ctx, "procesados.json");
  if (!existsSync(p)) return [];
  return readJSON<string[]>(p);
}

function saveProcesados(ctx: ToolContext, ids: string[]): void {
  writeFileSync(outPath(ctx, "procesados.json"), JSON.stringify(ids, null, 2));
}

function loadMaestro(ctx: ToolContext): MaestroRow[] {
  const outFile = outPath(ctx, "sharepoint", "maestro-contratos.csv");
  // RN6: copiar fixture si no existe en out/
  if (!existsSync(outFile)) {
    ensureOutDir(dirname(outFile));
    copyFileSync(fixturePath(ctx, "maestro-contratos.csv"), outFile);
  }
  const content = readFileSync(outFile, "utf-8").trim();
  const lines = content.split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = values[i] || ""));
    return row as unknown as MaestroRow;
  });
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function saveMaestro(ctx: ToolContext, rows: MaestroRow[]): void {
  const headers = [
    "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor",
    "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza",
    "estado_poliza", "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    const vals = headers.map((h) => {
      const v = (row as Record<string, string>)[h] || "";
      return v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    });
    lines.push(vals.join(","));
  }
  writeFileSync(outPath(ctx, "sharepoint", "maestro-contratos.csv"), lines.join("\n") + "\n");
}

function loadComerciales(ctx: ToolContext): Comercial[] {
  return readJSON<Comercial[]>(fixturePath(ctx, "comerciales.json"));
}

function resolverComercial(email: string, comerciales: Comercial[]): { nombre: string; conocido: boolean } {
  const found = comerciales.find((c) => c.email === email);
  return found ? { nombre: found.nombre, conocido: true } : { nombre: email, conocido: false };
}

function limpiarNit(nit: string): string {
  return nit.replace(/[\.\-\s]/g, "").replace(/-\d$/, "");
}

function inferirPais(nit: string, texto: string): string {
  if (/RUC/i.test(texto) && /Ecuador|Quito|Guayaquil/i.test(texto)) return "EC";
  if (/RUC/i.test(texto) && /Perú|Lima/i.test(texto)) return "PE";
  if (/RUC/i.test(texto) && /Panamá/i.test(texto)) return "PA";
  if (/RTN/i.test(texto) && /Honduras/i.test(texto)) return "HN";
  if (/NIT/i.test(texto) && /Colomb|Bogotá|Medellín|Barranquilla|Cali/i.test(texto)) return "CO";
  // por longitud de NIT
  const clean = limpiarNit(nit);
  if (clean.length === 13) return "EC"; // RUC Ecuador
  if (clean.length === 11) return "PE"; // RUC Perú
  if (clean.length === 14) return "HN"; // RTN Honduras
  return "CO"; // default Colombia
}

// ─── Extracción determinista de campos ──────────────────────────────────────

function extraerCamposDeTexto(texto: string): ContratoExtraido {
  // ID del contrato
  // Primero buscar formato "No. CT-XXXX-XXX" o "CM-XXXX-XX" (id explícito tipo código)
  const idExplicit = texto.match(/No\.\s*((?:CT|CM|CO)\-\d{4}\-\d{2,3})/i);
  // Si es otrosí, el id principal es el del otrosí mismo, no el del contrato referenciado
  const idOtrosi = texto.match(/OTROSÍ\s+No\.\s*(\d+)/i);
  let idContrato: string | null = null;
  if (idExplicit) {
    idContrato = idExplicit[1].trim();
  } else {
    const idMatch = texto.match(/(?:CONTRATO|OTROSÍ).*?No\.\s*([\w\-]+)/i);
    if (idMatch && idMatch[1].length > 2) idContrato = idMatch[1].trim();
  }

  // Cliente (primer nombre después de "entre ... " que no es Periferia)
  const parteMatch = texto.match(/(?:entre|Entre).*?,\s*([\w\s\.áéíóúñÁÉÍÓÚÑ]+(?:S\.A\.S\.|S\.A\.|S\.A\.C\.|S\. de R\.L\.))/);
  let cliente: string | null = null;
  if (parteMatch) {
    const candidate = parteMatch[1].trim();
    if (!/periferia/i.test(candidate)) {
      cliente = candidate;
    }
  }
  // Fallback: buscar en "entre ... EL CONTRATANTE"
  if (!cliente) {
    const altMatch = texto.match(/(?:entre|Entre)\s+(?:los suscritos,\s*)?([\w\s\.áéíóúñÁÉÍÓÚÑ]+(?:S\.A\.S\.|S\.A\.|S\.A\.C\.|S\. de R\.L\.))/);
    if (altMatch && !/periferia/i.test(altMatch[1])) {
      cliente = altMatch[1].trim();
    }
  }

  // NIT del cliente
  const nitMatches = texto.match(/(?:NIT|RUC|RTN)\s*([\d\.\-]+)/gi);
  let nitCliente: string | null = null;
  if (nitMatches) {
    for (const m of nitMatches) {
      const val = m.replace(/^(?:NIT|RUC|RTN)\s*/i, "").trim();
      const clean = limpiarNit(val);
      if (clean !== "900123456" && clean !== "9001234567") {
        nitCliente = clean;
        break;
      }
    }
  }

  // Objeto
  const objetoMatch = texto.match(/OBJETO\.\s*(?:EL CONTRATISTA\s+(?:se obliga a ejecutar|prestará)\s+)?(.+?)(?:\.|$)/im);
  let objeto = objetoMatch ? objetoMatch[1].trim().slice(0, 200) : null;
  if (objeto && /quedará así/i.test(objeto)) objeto = null; // es un otrosí, no el objeto

  // Valor
  // Buscar patrones como: "PEN 520,000.00" o "COP $265.000.000" o "USD 120.000"
  const valorPatterns = [
    /(?:COP|USD|PEN|PAB|HNL)\s*\$?\s*([\d\.,]+)/i,
    /valor\s+total.*?(?:es de|será de)\s+.*?([\d\.,]+)/i,
  ];
  let valor: number | null = null;
  for (const vp of valorPatterns) {
    const valorMatch = texto.match(vp);
    if (valorMatch) {
      let raw = valorMatch[1];
      // Determinar formato: si tiene punto como separador de miles y coma decimal (es: 265.000.000)
      // o punto decimal y coma miles (en: 520,000.00)
      if (raw.includes(",") && raw.includes(".")) {
        // Si el último separador es punto y tiene 2 dígitos después → formato 520,000.00
        if (/\.\d{2}$/.test(raw)) {
          valor = parseFloat(raw.replace(/,/g, ""));
        } else {
          // Formato 265.000,00
          valor = parseFloat(raw.replace(/\./g, "").replace(",", "."));
        }
      } else if (raw.includes(".")) {
        // Solo puntos: si más de un punto → separador de miles (265.000.000)
        const dotCount = (raw.match(/\./g) || []).length;
        if (dotCount > 1) {
          valor = parseFloat(raw.replace(/\./g, ""));
        } else {
          // Un solo punto: si tiene 3 dígitos después → miles (120.000), sino decimal (120.50)
          if (/\.\d{3}$/.test(raw)) {
            valor = parseFloat(raw.replace(/\./g, ""));
          } else {
            valor = parseFloat(raw);
          }
        }
      } else if (raw.includes(",")) {
        valor = parseFloat(raw.replace(/,/g, ""));
      } else {
        valor = parseFloat(raw);
      }
      if (!isNaN(valor!) && valor! > 0) break;
      valor = null;
    }
  }
  // Valor indeterminado
  const valorIndeterminado = /no tiene un valor determinado/i.test(texto);
  if (valorIndeterminado) valor = 0;

  // Moneda
  const monedaMatch = texto.match(/(COP|USD|PEN|PAB|HNL)/);
  const moneda = monedaMatch ? monedaMatch[1] : null;

  // Fechas
  const fechaInicioMatch = texto.match(/(?:desde el|a partir de)\s+.*?(\d{1,2})\s*\)?\s*de\s+(\w+)\s+de\s+(\d{4})/i);
  let fechaInicio: string | null = null;
  if (fechaInicioMatch) {
    fechaInicio = parsearFechaTexto(fechaInicioMatch[1], fechaInicioMatch[2], fechaInicioMatch[3]);
  }
  // Fallback: "a partir de la fecha de su firma" + fecha de firma
  if (!fechaInicio) {
    const firmaMatch = texto.match(/se firma.*?(?:el|a los)\s+.*?(\d{1,2})\s*\)?\s*(?:días?\s+)?del?\s+mes\s+de\s+(\w+)\s+de\s+(\d{4})/i);
    if (firmaMatch && /a partir de la fecha/i.test(texto)) {
      fechaInicio = parsearFechaTexto(firmaMatch[1], firmaMatch[2], firmaMatch[3]);
    }
  }

  // Fecha fin — buscar "hasta el ... de ... de YYYY" con posible palabra textual antes del número
  const fechaFinMatch = texto.match(/hasta el\s+(?:\w+\s+)?\(?(\d{1,2})\)?\s*(?:días?\s+)?(?:del?\s+mes\s+)?de\s+(\w+)\s+de\s+(\d{4})/i);
  let fechaFin: string | null = null;
  if (fechaFinMatch) {
    fechaFin = parsearFechaTexto(fechaFinMatch[1], fechaFinMatch[2], fechaFinMatch[3]);
  }

  // Plazo en meses (para derivar fecha_fin si no hay fecha explícita)
  if (!fechaFin && fechaInicio) {
    const plazoMatch = texto.match(/(?:duración de|plazo de)\s+(\w+)\s+\((\d+)\)\s*meses/i);
    if (plazoMatch) {
      const meses = parseInt(plazoMatch[2]);
      const inicio = new Date(fechaInicio);
      inicio.setMonth(inicio.getMonth() + meses);
      fechaFin = inicio.toISOString().split("T")[0];
    }
  }

  // Póliza
  const requierePoliza = /póliza|garantía|cumplimiento/i.test(texto) && !/no.*póliza|sin.*garantía/i.test(texto);
  let tipoPoliza = "";
  if (requierePoliza) {
    const tipos: string[] = [];
    if (/cumplimiento/i.test(texto)) tipos.push("cumplimiento");
    if (/calidad/i.test(texto)) tipos.push("calidad");
    if (/salarios/i.test(texto)) tipos.push("salarios_prestaciones");
    if (/responsabilidad.civil/i.test(texto)) tipos.push("responsabilidad_civil");
    tipoPoliza = tipos.join(";");
  }

  // Calcular confianzas
  const conf = (v: unknown): number => (v !== null && v !== undefined && v !== "" ? 1.0 : 0);
  const confValor = valorIndeterminado ? 0.5 : conf(valor);
  const confFechaFin = fechaFin && !fechaFinMatch ? 0.6 : conf(fechaFin); // derivado de plazo → menor confianza

  return {
    id_contrato: { valor: idContrato, confianza: conf(idContrato) },
    cliente: { valor: cliente, confianza: conf(cliente) },
    nit_cliente: { valor: nitCliente, confianza: conf(nitCliente) },
    pais: { valor: nitCliente ? inferirPais(nitCliente, texto) : null, confianza: nitCliente ? 0.9 : 0 },
    objeto: { valor: objeto, confianza: conf(objeto) },
    valor: { valor: valor, confianza: confValor },
    moneda: { valor: moneda, confianza: conf(moneda) },
    fecha_inicio: { valor: fechaInicio, confianza: conf(fechaInicio) },
    fecha_fin: { valor: fechaFin, confianza: confFechaFin },
    requiere_poliza: { valor: requierePoliza, confianza: 0.9 },
    tipo_poliza: { valor: tipoPoliza, confianza: requierePoliza && tipoPoliza ? 0.9 : requierePoliza ? 0.5 : 1.0 },
    estado_poliza: { valor: requierePoliza ? "pendiente" : "no_aplica", confianza: 1.0 },
  };
}

function parsearFechaTexto(dia: string, mes: string, anio: string): string {
  const meses: Record<string, string> = {
    enero: "01", febrero: "02", marzo: "03", abril: "04",
    mayo: "05", junio: "06", julio: "07", agosto: "08",
    septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
  };
  const m = meses[mes.toLowerCase()];
  if (!m) return `${anio}-01-01`;
  return `${anio}-${m}-${dia.padStart(2, "0")}`;
}

function esOtrosi(texto: string): boolean {
  return /OTROSÍ/i.test(texto);
}

function similaridad(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-záéíóúñ\d\s]/g, "").trim();
  const nb = b.toLowerCase().replace(/[^a-záéíóúñ\d\s]/g, "").trim();
  if (na === nb) return 1.0;
  const wordsA = new Set(na.split(/\s+/));
  const wordsB = new Set(nb.split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── Herramientas ───────────────────────────────────────────────────────────

export const leer_buzon = {
  description: "Lista los mensajes pendientes del buzón con metadatos y si cada uno tiene adjunto de contrato.",
  args: {},
  async execute(_args: Record<string, never>, ctx: ToolContext): Promise<string> {
    try {
      const procesados = loadProcesados(ctx);
      const { readdirSync } = await import("fs");
      const dirs = readdirSync(fixturePath(ctx, "buzon")).filter((d: string) => d.startsWith("msg-")).sort();

      const mensajes: Mensaje[] = [];
      for (const dir of dirs) {
        const correoPath = fixturePath(ctx, "buzon", dir, "correo.json");
        if (!existsSync(correoPath)) continue;
        const correo = readJSON<{ id: string; de: string; para: string; asunto: string; fecha: string; cuerpo: string; adjuntos: string[] }>(correoPath);

        const tieneContrato = correo.adjuntos.some(
          (a: string) => a === "contrato.txt" || a === "otrosi.txt"
        );

        mensajes.push({
          ...correo,
          tiene_contrato: tieneContrato,
        });
      }

      logEntry(ctx, { herramienta: "leer_buzon", ok: true, resumen: `${mensajes.length} mensajes encontrados, ${procesados.length} procesados` });

      return JSON.stringify({
        ok: true,
        data: {
          mensajes: mensajes.map((m) => ({
            ...m,
            procesado: procesados.includes(m.id),
          })),
          total: mensajes.length,
          pendientes: mensajes.filter((m) => !procesados.includes(m.id)).length,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEntry(ctx, { herramienta: "leer_buzon", ok: false, resumen: msg });
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

export const extraer = {
  description: "Lee el contrato adjunto de un mensaje y extrae los datos estructurados con nivel de confianza por campo.",
  args: {
    mensaje_id: z.string().describe("ID del mensaje en el buzón (ej: msg-001)"),
  },
  async execute(args: { mensaje_id: string }, ctx: ToolContext): Promise<string> {
    try {
      const msgDir = fixturePath(ctx, "buzon", args.mensaje_id);
      if (!existsSync(msgDir)) {
        return JSON.stringify({ ok: false, error: `Mensaje ${args.mensaje_id} no encontrado` });
      }

      const correo = readJSON<{ adjuntos: string[] }>(join(msgDir, "correo.json"));

      // Buscar el adjunto de contrato
      const contratoFile = correo.adjuntos.find((a: string) => a === "contrato.txt" || a === "otrosi.txt");
      if (!contratoFile) {
        logEntry(ctx, { herramienta: "extraer", mensaje_id: args.mensaje_id, ok: false, resumen: "Sin adjunto de contrato" });
        return JSON.stringify({ ok: false, error: `El mensaje ${args.mensaje_id} no tiene adjunto de contrato (adjuntos: ${correo.adjuntos.join(", ")})` });
      }

      const texto = readFileSync(join(msgDir, contratoFile), "utf-8");
      const contrato = extraerCamposDeTexto(texto);
      const esOtrosiDoc = esOtrosi(texto);

      // Si es otrosí, buscar el id del contrato original referenciado
      let idContratoOriginal: string | null = null;
      if (esOtrosiDoc) {
        // Buscar "contrato No. CT-XXXX-XXX" o "AL CONTRATO ... No. CT-XXXX-XXX"
        const refMatch = texto.match(/contrato.*?No\.\s*((?:CT|CM|CO)\-\d{4}\-\d{2,3})/i);
        if (refMatch) {
          idContratoOriginal = refMatch[1].trim();
        }
      }

      logEntry(ctx, { herramienta: "extraer", mensaje_id: args.mensaje_id, ok: true, resumen: `Extraído ${contrato.id_contrato.valor}, otrosí: ${esOtrosiDoc}` });

      return JSON.stringify({
        ok: true,
        data: {
          contrato,
          es_otrosi: esOtrosiDoc,
          id_contrato_original: idContratoOriginal,
          texto_fuente: contratoFile,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEntry(ctx, { herramienta: "extraer", mensaje_id: args.mensaje_id, ok: false, resumen: msg });
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

export const validar = {
  description: "Clasifica un contrato extraído como nuevo, actualización, duplicado o rechazado comparándolo con el maestro vigente.",
  args: {
    mensaje_id: z.string().describe("ID del mensaje"),
    contrato: z.any().describe("Objeto contrato extraído por contratos_extraer"),
  },
  async execute(args: { mensaje_id: string; contrato: ContratoExtraido & { es_otrosi?: boolean; id_contrato_original?: string | null } }, ctx: ToolContext): Promise<string> {
    try {
      const maestro = loadMaestro(ctx);
      const comerciales = loadComerciales(ctx);
      const correo = readJSON<{ de: string; adjuntos: string[] }>(fixturePath(ctx, "buzon", args.mensaje_id, "correo.json"));

      // Si el LLM pasa contrato como string JSON, parsearlo
      let contrato = args.contrato;
      if (typeof contrato === "string") {
        try { contrato = JSON.parse(contrato); } catch { /* usar tal cual */ }
      }
      // Si no viene contrato válido, extraer directamente del mensaje
      if (!contrato || typeof contrato !== "object" || !contrato.id_contrato) {
        const extractResult = JSON.parse(await extraer.execute({ mensaje_id: args.mensaje_id }, ctx));
        if (extractResult.ok) {
          contrato = extractResult.data;
        }
      }
      const idContrato = contrato.id_contrato?.valor as string | null;
      const nitCliente = contrato.nit_cliente?.valor as string | null;
      const objeto = contrato.objeto?.valor as string | null;
      const valor = contrato.valor?.valor as number | null;
      const fechaInicio = contrato.fecha_inicio?.valor as string | null;
      const fechaFin = contrato.fecha_fin?.valor as string | null;
      const esOtrosiDoc = contrato.es_otrosi || false;
      const idOriginal = contrato.id_contrato_original || null;

      // Verificar si tiene contrato
      if (!correo.adjuntos.some((a: string) => a === "contrato.txt" || a === "otrosi.txt")) {
        logEntry(ctx, { herramienta: "validar", mensaje_id: args.mensaje_id, ok: true, resumen: "rechazado: sin contrato" });
        return JSON.stringify({
          ok: true,
          data: {
            clasificacion: "rechazado",
            motivo: "El mensaje no contiene adjunto de contrato (contiene: " + correo.adjuntos.join(", ") + ")",
            requiere_revision: [],
          },
        });
      }

      // Si no se pudo extraer id ni partes identificables → rechazado
      if (!idContrato && !nitCliente) {
        logEntry(ctx, { herramienta: "validar", mensaje_id: args.mensaje_id, ok: true, resumen: "rechazado: datos insuficientes" });
        return JSON.stringify({
          ok: true,
          data: {
            clasificacion: "rechazado",
            motivo: "No se identificaron partes ni número de contrato en el documento",
            requiere_revision: [],
          },
        });
      }

      // Resolver comercial
      const { nombre: comercialNombre, conocido: comercialConocido } = resolverComercial(correo.de, comerciales);

      // Buscar en maestro
      const idParaBuscar = esOtrosiDoc && idOriginal ? idOriginal : idContrato;
      let filaExistente: MaestroRow | undefined;

      // RN1-RN3: buscar por id_contrato
      if (idParaBuscar) {
        filaExistente = maestro.find((r) => r.id_contrato === idParaBuscar);
      }

      // Buscar por NIT + objeto similar
      if (!filaExistente && nitCliente && objeto) {
        filaExistente = maestro.find((r) => {
          if (limpiarNit(r.nit_cliente) !== limpiarNit(nitCliente)) return false;
          return similaridad(r.objeto, objeto) >= 0.9;
        });
      }

      // Campos con baja confianza
      const requiereRevision: string[] = [];
      for (const [campo, data] of Object.entries(contrato)) {
        if (campo === "es_otrosi" || campo === "id_contrato_original") continue;
        const d = data as CampoConfianza;
        if (d && typeof d === "object" && "confianza" in d && d.confianza < 0.8) {
          requiereRevision.push(`${campo} (confianza: ${d.confianza}, valor: ${JSON.stringify(d.valor)})`);
        }
      }

      if (!comercialConocido) {
        requiereRevision.push(`comercial (remitente ${correo.de} no registrado en comerciales.json)`);
      }

      let clasificacion: "nuevo" | "actualizacion" | "duplicado";
      let diferencias: Record<string, { maestro: string; contrato: unknown }> | undefined;
      let idContratoExistente: string | undefined;

      if (filaExistente) {
        idContratoExistente = filaExistente.id_contrato;

        if (esOtrosiDoc) {
          // RN2: es otrosí → actualización
          clasificacion = "actualizacion";
          diferencias = {};
          if (valor !== null && String(valor) !== filaExistente.valor) {
            diferencias.valor = { maestro: filaExistente.valor, contrato: valor };
          }
          if (fechaFin && fechaFin !== filaExistente.fecha_fin) {
            diferencias.fecha_fin = { maestro: filaExistente.fecha_fin, contrato: fechaFin };
          }
        } else {
          // Verificar si es duplicado (mismo id + mismos valor, fecha_inicio, fecha_fin)
          const mismoValor = valor !== null && String(valor) === filaExistente.valor;
          const mismaInicio = fechaInicio === filaExistente.fecha_inicio;
          const mismaFin = fechaFin === filaExistente.fecha_fin;

          if (mismoValor && mismaInicio && mismaFin) {
            // RN1: duplicado
            clasificacion = "duplicado";
          } else {
            // RN2: actualización
            clasificacion = "actualizacion";
            diferencias = {};
            if (!mismoValor && valor !== null) diferencias.valor = { maestro: filaExistente.valor, contrato: valor };
            if (!mismaInicio && fechaInicio) diferencias.fecha_inicio = { maestro: filaExistente.fecha_inicio, contrato: fechaInicio };
            if (!mismaFin && fechaFin) diferencias.fecha_fin = { maestro: filaExistente.fecha_fin, contrato: fechaFin };
          }
        }
      } else {
        // RN3: nuevo
        clasificacion = "nuevo";
      }

      logEntry(ctx, { herramienta: "validar", mensaje_id: args.mensaje_id, ok: true, resumen: `${clasificacion}, revisión: ${requiereRevision.length} campos` });

      return JSON.stringify({
        ok: true,
        data: {
          clasificacion,
          id_contrato_existente: idContratoExistente,
          requiere_revision: requiereRevision,
          diferencias,
          comercial: { nombre: comercialNombre, conocido: comercialConocido },
          es_otrosi: esOtrosiDoc,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEntry(ctx, { herramienta: "validar", mensaje_id: args.mensaje_id, ok: false, resumen: msg });
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

export const registrar = {
  description: "Registra o actualiza un contrato en el maestro y archiva el documento. Requiere confirmación explícita si hay campos en revisión.",
  args: {
    mensaje_id: z.string().describe("ID del mensaje"),
    contrato: z.any().describe("Objeto contrato extraído"),
    confirmado: z.boolean().optional().describe("true si el usuario confirmó los campos en revisión"),
  },
  async execute(args: { mensaje_id: string; contrato: ContratoExtraido & { es_otrosi?: boolean; id_contrato_original?: string | null }; confirmado?: boolean }, ctx: ToolContext): Promise<string> {
    try {
      // Primero validar
      const validacionStr = await validar.execute({ mensaje_id: args.mensaje_id, contrato: args.contrato }, ctx);
      const validacion = JSON.parse(validacionStr);
      if (!validacion.ok) return validacionStr;

      const { clasificacion, requiere_revision, id_contrato_existente, diferencias, comercial } = validacion.data;

      // Duplicado → no escribir
      if (clasificacion === "duplicado") {
        logEntry(ctx, { herramienta: "registrar", mensaje_id: args.mensaje_id, ok: true, resumen: "duplicado, sin escritura" });
        return JSON.stringify({
          ok: true,
          data: { clasificacion: "duplicado", id_contrato: id_contrato_existente, accion: "ninguna", motivo: "Contrato ya registrado con los mismos datos" },
        });
      }

      // Rechazado → no escribir
      if (clasificacion === "rechazado") {
        return JSON.stringify({ ok: true, data: { clasificacion: "rechazado", accion: "ninguna", motivo: validacion.data.motivo } });
      }

      // RN5: requiere revisión sin confirmación → rechazar
      if (requiere_revision.length > 0 && !args.confirmado) {
        logEntry(ctx, { herramienta: "registrar", mensaje_id: args.mensaje_id, ok: false, resumen: `requiere revisión: ${requiere_revision.join(", ")}` });
        return JSON.stringify({
          ok: false,
          error: `Requiere revisión antes de registrar: ${requiere_revision.join("; ")}. Envíe confirmado=true para forzar el registro.`,
        });
      }

      const contrato = args.contrato;
      const maestro = loadMaestro(ctx);
      const idContrato = (contrato.es_otrosi && contrato.id_contrato_original) || contrato.id_contrato?.valor as string || `AUTO-${new Date().getFullYear()}-${String(maestro.length + 1).padStart(3, "0")}`;

      const hoy = new Date().toISOString().split("T")[0];

      if (clasificacion === "actualizacion" && id_contrato_existente) {
        // Actualizar fila existente
        const idx = maestro.findIndex((r) => r.id_contrato === id_contrato_existente);
        if (idx >= 0) {
          const old = { ...maestro[idx] };
          if (diferencias) {
            for (const [campo, diff] of Object.entries(diferencias)) {
              (maestro[idx] as Record<string, unknown>)[campo] = String(diff.contrato);
            }
          }
          maestro[idx].fecha_registro = hoy;

          saveMaestro(ctx, maestro);

          // Historial
          const historialEntry = {
            ts: new Date().toISOString(),
            id_contrato: id_contrato_existente,
            accion: "actualizacion",
            cambios: diferencias,
            mensaje_id: args.mensaje_id,
          };
          appendFileSync(outPath(ctx, "sharepoint", "historial.jsonl"), JSON.stringify(historialEntry) + "\n");

          // Archivar el documento
          const correo = readJSON<{ adjuntos: string[] }>(fixturePath(ctx, "buzon", args.mensaje_id, "correo.json"));
          const adjunto = correo.adjuntos.find((a: string) => a === "contrato.txt" || a === "otrosi.txt");
          const year = old.fecha_inicio.split("-")[0];
          const clienteSlug = old.cliente.toLowerCase().replace(/[^a-záéíóúñ\d]+/g, "-").replace(/-+$/, "");
          let rutaArchivo = `Contratos/${year}/${clienteSlug}`;
          if (adjunto) {
            const destDir = outPath(ctx, "sharepoint", "Contratos", year, clienteSlug);
            ensureOutDir(destDir);
            copyFileSync(fixturePath(ctx, "buzon", args.mensaje_id, adjunto), join(destDir, `${id_contrato_existente}-otrosi-1.txt`));
          }

          // Marcar procesado
          const procesados = loadProcesados(ctx);
          if (!procesados.includes(args.mensaje_id)) {
            procesados.push(args.mensaje_id);
            saveProcesados(ctx, procesados);
          }

          logEntry(ctx, { herramienta: "registrar", mensaje_id: args.mensaje_id, ok: true, resumen: `actualización ${id_contrato_existente}` });

          return JSON.stringify({
            ok: true,
            data: { id_contrato: id_contrato_existente, accion: "actualizacion", diferencias, ruta_archivo: rutaArchivo },
          });
        }
      }

      // Nuevo registro
      const pais = contrato.pais?.valor as string || "CO";
      const fechaInicio = contrato.fecha_inicio?.valor as string || hoy;
      const year = fechaInicio.split("-")[0];
      const clienteStr = contrato.cliente?.valor as string || "desconocido";
      const clienteSlug = clienteStr.toLowerCase().replace(/[^a-záéíóúñ\d]+/g, "-").replace(/-+$/, "");
      const rutaSharepoint = `Contratos/${year}/${clienteSlug}/${idContrato}.txt`;

      const newRow: MaestroRow = {
        id_contrato: idContrato as string,
        cliente: clienteStr,
        nit_cliente: contrato.nit_cliente?.valor as string || "",
        pais,
        objeto: (contrato.objeto?.valor as string || "").slice(0, 200),
        valor: String(contrato.valor?.valor ?? 0),
        moneda: contrato.moneda?.valor as string || "COP",
        fecha_inicio: fechaInicio,
        fecha_fin: contrato.fecha_fin?.valor as string || "",
        requiere_poliza: String(contrato.requiere_poliza?.valor ?? false),
        tipo_poliza: contrato.tipo_poliza?.valor as string || "",
        estado_poliza: contrato.estado_poliza?.valor as string || "no_aplica",
        comercial: comercial?.nombre || "",
        ruta_sharepoint: rutaSharepoint,
        fecha_registro: hoy,
        fuente: "buzon",
      };

      maestro.push(newRow);
      saveMaestro(ctx, maestro);

      // Archivar documento
      const correo = readJSON<{ adjuntos: string[] }>(fixturePath(ctx, "buzon", args.mensaje_id, "correo.json"));
      const adjunto = correo.adjuntos.find((a: string) => a === "contrato.txt" || a === "otrosi.txt");
      if (adjunto) {
        const destDir = outPath(ctx, "sharepoint", "Contratos", year, clienteSlug);
        ensureOutDir(destDir);
        copyFileSync(fixturePath(ctx, "buzon", args.mensaje_id, adjunto), join(destDir, `${idContrato}.txt`));
      }

      // Historial
      const historialEntry = {
        ts: new Date().toISOString(),
        id_contrato: idContrato,
        accion: "nuevo",
        cambios: null,
        mensaje_id: args.mensaje_id,
      };
      appendFileSync(outPath(ctx, "sharepoint", "historial.jsonl"), JSON.stringify(historialEntry) + "\n");

      // Marcar procesado
      const procesados = loadProcesados(ctx);
      if (!procesados.includes(args.mensaje_id)) {
        procesados.push(args.mensaje_id);
        saveProcesados(ctx, procesados);
      }

      logEntry(ctx, { herramienta: "registrar", mensaje_id: args.mensaje_id, ok: true, resumen: `nuevo ${idContrato}` });

      return JSON.stringify({
        ok: true,
        data: { id_contrato: idContrato, accion: "nuevo", ruta_archivo: rutaSharepoint },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEntry(ctx, { herramienta: "registrar", mensaje_id: args.mensaje_id, ok: false, resumen: msg });
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};

export const alertas = {
  description: "Genera un reporte de alertas con contratos próximos a vencer, pólizas pendientes y contratos registrados desde el corte.",
  args: {
    hoy: z.string().describe("Fecha de referencia en formato YYYY-MM-DD para calcular vencimientos"),
  },
  async execute(args: { hoy: string }, ctx: ToolContext): Promise<string> {
    try {
      const maestro = loadMaestro(ctx);
      const hoy = new Date(args.hoy);
      const en60Dias = new Date(hoy);
      en60Dias.setDate(en60Dias.getDate() + 60);
      const fechaCorte = "2026-05-30";

      const vencen: { id_contrato: string; cliente: string; fecha_fin: string; dias_restantes: number }[] = [];
      const polizasPendientes: { id_contrato: string; cliente: string; requiere_poliza: string; estado_poliza: string; tipo_poliza: string }[] = [];
      const registradosDesdeCorte: { id_contrato: string; cliente: string; fecha_registro: string; fuente: string }[] = [];

      for (const row of maestro) {
        // Vencen en <= 60 días
        if (row.fecha_fin) {
          const fin = new Date(row.fecha_fin);
          if (fin >= hoy && fin <= en60Dias) {
            const dias = Math.ceil((fin.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
            vencen.push({ id_contrato: row.id_contrato, cliente: row.cliente, fecha_fin: row.fecha_fin, dias_restantes: dias });
          }
        }

        // Pólizas pendientes o vencidas
        if (row.requiere_poliza === "true" && row.estado_poliza !== "vigente" && row.estado_poliza !== "no_aplica") {
          polizasPendientes.push({
            id_contrato: row.id_contrato,
            cliente: row.cliente,
            requiere_poliza: row.requiere_poliza,
            estado_poliza: row.estado_poliza,
            tipo_poliza: row.tipo_poliza,
          });
        }

        // Registrados desde el corte
        if (row.fecha_registro > fechaCorte) {
          registradosDesdeCorte.push({
            id_contrato: row.id_contrato,
            cliente: row.cliente,
            fecha_registro: row.fecha_registro,
            fuente: row.fuente,
          });
        }
      }

      // Generar Markdown
      let md = `# Reporte de Alertas de Contratos\n\n`;
      md += `Fecha de referencia: ${args.hoy}\n\n`;

      md += `## Contratos que vencen en ≤ 60 días\n\n`;
      if (vencen.length === 0) {
        md += `No hay contratos próximos a vencer.\n\n`;
      } else {
        md += `| Contrato | Cliente | Fecha fin | Días restantes |\n|---|---|---|---|\n`;
        for (const v of vencen) {
          md += `| ${v.id_contrato} | ${v.cliente} | ${v.fecha_fin} | ${v.dias_restantes} |\n`;
        }
        md += "\n";
      }

      md += `## Pólizas pendientes o vencidas\n\n`;
      if (polizasPendientes.length === 0) {
        md += `No hay pólizas pendientes.\n\n`;
      } else {
        md += `| Contrato | Cliente | Tipo póliza | Estado |\n|---|---|---|---|\n`;
        for (const p of polizasPendientes) {
          md += `| ${p.id_contrato} | ${p.cliente} | ${p.tipo_poliza} | ${p.estado_poliza} |\n`;
        }
        md += "\n";
      }

      md += `## Contratos registrados desde el corte (${fechaCorte})\n\n`;
      if (registradosDesdeCorte.length === 0) {
        md += `No hay contratos registrados desde el corte.\n\n`;
      } else {
        md += `| Contrato | Cliente | Fecha registro | Fuente |\n|---|---|---|---|\n`;
        for (const r of registradosDesdeCorte) {
          md += `| ${r.id_contrato} | ${r.cliente} | ${r.fecha_registro} | ${r.fuente} |\n`;
        }
        md += "\n";
      }

      const alertasPath = outPath(ctx, "alertas.md");
      writeFileSync(alertasPath, md);

      logEntry(ctx, { herramienta: "alertas", ok: true, resumen: `vencen: ${vencen.length}, pólizas: ${polizasPendientes.length}, desde corte: ${registradosDesdeCorte.length}` });

      return JSON.stringify({
        ok: true,
        data: {
          ruta: "out/alertas.md",
          vencen,
          polizas_pendientes: polizasPendientes,
          registrados_desde_corte: registradosDesdeCorte,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEntry(ctx, { herramienta: "alertas", ok: false, resumen: msg });
      return JSON.stringify({ ok: false, error: msg });
    }
  },
};
