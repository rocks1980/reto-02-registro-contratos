---
name: registro-contratos
description: Conocimiento del proceso de registro de contratos vigentes de Periferia IT Group. Reglas de negocio, clasificación, extracción y gobierno.
---

# Proceso de Registro de Contratos Vigentes

## Contexto

Periferia IT Group gestiona contratos de servicios tecnológicos con clientes en Colombia, Perú, Ecuador, Honduras y Panamá. Los comerciales envían los contratos firmados por correo electrónico a un buzón centralizado.

## Clasificación de contratos

| Clasificación | Condición | Acción |
|---|---|---|
| `nuevo` | No existe en el maestro (por ID ni por NIT + objeto similar) | Crear registro |
| `actualizacion` | Existe pero con datos diferentes (otrosí, ampliación) | Actualizar campos modificados |
| `duplicado` | Existe con mismos valor, fecha_inicio y fecha_fin | No escribir |
| `rechazado` | El adjunto no es un contrato (cotización, factura, etc.) | No escribir |

## Campos del maestro

`id_contrato`, `cliente`, `nit_cliente`, `pais`, `objeto`, `valor`, `moneda`, `fecha_inicio`, `fecha_fin`, `requiere_poliza`, `tipo_poliza`, `estado_poliza`, `comercial`, `ruta_sharepoint`, `fecha_registro`, `fuente`.

## Confianza y revisión humana

Cada campo extraído tiene un nivel de confianza (0 a 1). Si algún campo tiene confianza < 0.8, el contrato se marca como `requiere_revision` y el agente debe solicitar confirmación al usuario antes de registrar.

Campos típicos con baja confianza:
- Valor "indeterminado" o "por demanda" → confianza 0.5
- Fecha derivada de plazo en meses → confianza 0.6
- Remitente no registrado en comerciales → marcado en revisión

## Tipos de documento fiscal por país

| País | Documento | Prefijo |
|---|---|---|
| Colombia | NIT | CO |
| Perú | RUC (11 dígitos) | PE |
| Ecuador | RUC (13 dígitos) | EC |
| Honduras | RTN | HN |
| Panamá | RUC | PA |

## Pólizas

Los contratos pueden requerir pólizas de: cumplimiento, calidad, salarios y prestaciones, responsabilidad civil. El estado inicial es siempre `pendiente` si el contrato las requiere.

## Archivado

Los documentos procesados se archivan en: `Contratos/{año}/{cliente-slug}/{id_contrato}.txt`
Los otrosíes se archivan como: `{id_contrato}-otrosi-{n}.txt`
