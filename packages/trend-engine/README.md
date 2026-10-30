# @earlyscript/trend-engine

Motor determinista de tendencias: corpus congelado (`corpus/1`) hasta un corte, perfil del canal y configuración en; carpeta de corrida con `run.json` y expedientes fuera. No usa modelo de lenguaje ni depende de T3. Porta el método de Earlywindow `engine.v0.02` (procedencia en la cabecera de cada archivo).

```sh
pnpm --filter @earlyscript/trend-engine engine run \
  --corpus ~/earlywindow-data/corpus --cutoff 2026-10-19T00:00:00Z \
  --profile /ruta/singularidev.v1.json --out ~/earlyscript-data/runs
pnpm --filter @earlyscript/trend-engine engine check --run <carpeta> [--rerun --out <dir>]
```

pnpm ejecuta el script en la carpeta del paquete: usar rutas absolutas. Opciones: `--config` (por defecto `config/engine.v1.json`), `--workers` (procesos de Qwen, 2 por defecto porque la máquina se comparte; cada uno usa unos 1,2 a 1,9 GB), `--cache`, `--models`, `--allow-unverified-corpus` (copia del corpus que ya no coincide con su manifiesto, por ejemplo con un día quitado).

## Ciclo

1. `sources/`: un adaptador por fuente y día. `fixture` reproduce `<fuente>/<día>.jsonl` y `coverage.jsonl`; los adaptadores en vivo de HN y GitHub implementan la misma interfaz `SourceAdapter`.
2. Corte: el corte se aplica antes de abrir archivos. Solo se leen y se hashean `coverage.jsonl` y los archivos de días anteriores al corte, comparados con su entrada en `corpus-manifest.json`; los de días posteriores no se abren, aunque estén corruptos o sin permisos de lectura. Los ítems posteriores se filtran.
3. Embeddings: Qwen3-Embedding-0.6B ONNX q8 por transformers.js en procesos hijo. Caché SQLite (por defecto `~/earlyscript-data/embeddings/embeddings.sqlite`) con clave de modelo, revisión, dtype, pooling, lote, runtime con hilos, plataforma, arquitectura y hash del texto. El vector de un texto no depende de cuántos procesos ni hilos lo calculan.
4. Apilado por coseno mayor que 0,70 con ventana activa de 30 días, series por día con `known` según cobertura.
5. Dos rankings sobre las tendencias elegibles (creciendo y dentro del perfil): `baseline.items_7d` y `weighted_sum.v0.01` (crecimiento 0,5, autores 0,2, afinidad 0,3). Los expedientes se escriben en orden de línea base.
6. Cobertura: un día sin datos queda `known: false` y en `data_gaps`; con `stage.coverage_rule: per_source` no deja la lista vacía. Los días `partial` de GitHub son su muestra declarada y no cuentan como hueco.
7. `run.json` lleva corte, configuración y su hash, `corpus.corpus_used_hash` (archivos de días y filas de cobertura anteriores al corte; es el `engine.corpus_hash` de cada expediente y entra en `logical_hash`), `corpus.corpus_manifest_hash` (identidad del corpus congelado tomada del manifiesto), plataforma, cobertura, tiempos, memoria pico y `logical_hash`: SHA-256 de los expedientes sin `run_id`, `dossier_id` ni `created_at`. `stats.signals_hash` cubre todas las señales, no solo las emitidas.

## Capturar fuentes con `collect`

```sh
pnpm --filter @earlyscript/trend-engine engine collect \
  --corpus ~/earlyscript-data/corpus --sources hn,github \
  --from 2026-10-29 --to 2026-10-30
```

`--from` incluye el día y `--to` lo excluye. Cada día usa UTC. El comando escribe el formato `corpus/1`: `<fuente>/<día>.jsonl`, `coverage.jsonl` y `corpus-manifest.json`, con SHA-256 y tamaños en bytes. No ejecuta embeddings ni modelos. Emite las filas de cobertura como JSON.

HN usa `https://hn.algolia.com/api/v1/search_by_date`, igual que Earlywindow: historias sin filtro por palabras ni puntuación, sin comentarios. Si una ventana no contiene todos los resultados, la divide hasta un segundo. GitHub usa `https://api.github.com/search/repositories`: `created:day-7..day stars:>=20 fork:false`, orden descendente por estrellas, primera página de 100. Guarda solo los repositorios creados en el día solicitado. Las estrellas y descripciones son actuales: la cobertura de GitHub siempre es `partial`, incluso con cero coincidencias. No representa actividad histórica completa.

No hacen falta claves. `GITHUB_TOKEN`, si existe, se envía solo a GitHub para ampliar su cuota. El cliente no guarda ni registra cabeceras, cuerpos de error ni credenciales. Hay una petición simultánea, pausas mínimas de 250 ms para HN y 6500 ms para GitHub, hasta tres reintentos con espera exponencial, respeto de `Retry-After` y del reinicio de cuota. El límite es 45 segundos por petición y cinco minutos por fuente y día. No se espera una cuota que exceda ese presupuesto.

Un día HN `complete` se omite salvo con `--force`. Los demás días se pueden reintentar. Una captura incompleta queda `partial` si conserva ítems o `unavailable` si no tiene evidencia. El motivo se guarda en `note` y la captura sigue con los otros días. Los ítems previos se unen por ID con los nuevos. Las versiones reemplazadas se conservan por hash en `history/`, también en el manifiesto. Los archivos se reemplazan mediante renombre y `.collect.lock` impide escritores simultáneos. El comando rechaza un corpus cuyo manifiesto o archivos ya no coinciden. Si el proceso se interrumpe entre archivos, requiere revisar el corpus antes de continuar: no hay transacción que abarque todo el directorio.

El fixture `src/testkit/hn-live-reference.jsonl` contiene 20 líneas públicas del corpus congelado de Earlywindow (`hn/2026-10-15.jsonl`), usadas para comprobar todos los campos de los ítems sin red.
