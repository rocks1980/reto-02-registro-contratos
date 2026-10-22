/**
 * Reglas de negocio — conocimiento del dominio separado de la ejecución.
 * Cambiar una regla aquí no debería tocar ni el servidor ni el prompt.
 */

/** Umbral de confianza bajo el cual un campo requiere revisión humana */
export const UMBRAL_CONFIANZA = 0.8;

/** Días para alerta de vencimiento */
export const DIAS_ALERTA_VENCIMIENTO = 60;

/** Fecha de corte del maestro congelado */
export const FECHA_CORTE_MAESTRO = "2026-05-30";

/** NIT de Periferia (excluido de la extracción del cliente) */
export const NIT_PERIFERIA = "9001234567";

/** Clasificaciones posibles */
export const CLASIFICACIONES = ["nuevo", "actualizacion", "duplicado", "rechazado"] as const;
export type Clasificacion = typeof CLASIFICACIONES[number];

/** Umbral de similaridad para detección de duplicados por objeto */
export const UMBRAL_SIMILARIDAD_OBJETO = 0.9;

/** Monedas soportadas */
export const MONEDAS_SOPORTADAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const;

/** Mapeo de tipo de documento fiscal por longitud (cuando no hay contexto textual) */
export const DOCUMENTO_FISCAL_POR_LONGITUD: Record<number, string> = {
  13: "EC", // RUC Ecuador
  11: "PE", // RUC Perú
  14: "HN", // RTN Honduras
};

/** País por defecto cuando no se puede inferir */
export const PAIS_DEFAULT = "CO";
