# @earlyscript/trend-engine

Motor determinista de tendencias: corpus congelado (`corpus/1`) hasta un corte, perfil del canal y configuración en; carpeta de corrida con `run.json` y expedientes fuera. No usa modelo de lenguaje ni depende de T3. Porta el método de Earlywindow `engine.v0.02` (procedencia en la cabecera de cada archivo).

```sh
pnpm --filter @earlyscript/trend-engine engine run \
  --corpus ~/earlywindow-data/corpus --cutoff 2026-10-19T00:00:00Z \
  --profile /ruta/singularidev.v1.json --out ~/earlyscript-data/runs
pnpm --filter @earlyscript/trend-engine engine check --run <carpeta> [--rerun --out <dir>]
```

pnpm ejecuta el script en la carpeta del paquete: usar rutas absolutas. Opciones: `--config` (por defecto `config/engine.v1.json`), `--workers` (procesos de Qwen, 2 por defecto porque la máquina se comparte; cada uno usa unos 1,2 a 1,9 GB), `--cache`, `--models`, `--allow-unverified-corpus` (copia del corpus que ya no coincide con su manifiesto, por ejemplo con un día quitado).

`--cache-only` abre una caché existente en solo lectura. Un texto sin embedding interrumpe la operación antes de preparar el modelo. No descarga ni infiere; tampoco crea una base vacía.

## Repetir backtests sin inferencias

Repite `--candidate` para comparar varias combinaciones contra el mismo baseline. La matriz reutiliza los cálculos del baseline y guarda cada informe bajo el nombre de sus fuentes. Conserva la carpeta completa: los informes pueden referenciar una misma corrida base.

```sh
pnpm --filter @earlyscript/trend-engine engine backtest \
  --corpus /ruta/corpus --profile /ruta/perfil.json \
  --cache /ruta/embeddings.sqlite --cache-only --out /ruta/matriz \
  --cutoffs 2026-10-17..2026-10-18 --baseline hn,github --truth hn \
  --candidate hn,github,npm --candidate hn,github,huggingface
```

Los candidatos de una matriz deben contener todas las fuentes base. La reutilización dura una llamada y exige el mismo corte, configuración base, perfil, especificación de embeddings, corpus y seguimiento. Cada candidato verifica sus archivos de entrada antes de emitir el informe.

Las referencias reutilizadas llevan `reused: true`; su duración corresponde a la ejecución original. `--allow-unverified-corpus` desactiva esta reutilización porque el manifiesto ya no identifica las entradas con garantías.

Dentro de cada brazo, el agrupamiento continúa desde el corte anterior si sus entradas son un prefijo idéntico. Comprueba IDs, fechas y bytes de vectores mediante SHA-256. Un cambio de prefijo, umbral o ventana reinicia el agrupamiento. El estado vive solo durante el backtest; cada resultado se consume antes de avanzar al siguiente corte. `--independent-cuts` fuerza el cálculo completo de cada corte como referencia.

Para repetir un informe después de mover sus entradas, pasa `--corpus` y `--profile` a `check --backtest ... --rerun --out ...`. Sus hashes deben coincidir con los registrados. El informe original permanece intacto.

El banco `scripts/earlyscript/benchmark-trends.py`, ejecutado desde la raíz, compara ejecuciones independientes por fuente y corte con la matriz incremental. Recibe `--corpus`, `--profile`, `--cache`, `--cutoffs`, `--out` y un `--candidate` por combinación; admite `--truth`. Usa tres repeticiones, alterna el orden de las variantes y falla si sus hashes lógicos difieren. Guarda comandos, salidas, tiempos y hashes en la carpeta de salida, que debe ser nueva.

Medición del 4 de noviembre de 2026 sobre `822dd475b6`: tres repeticiones de npm, Hugging Face, arXiv, Wikipedia y Stack Exchange, cortes del 17 al 19 de octubre, baseline HN/GitHub, verdad HN y embeddings en caché. En Linux x64, Intel Xeon E5-1620 v3 y Node v24.22.2, la mediana pasó de 748,3 a 217,8 segundos, un 70,9 % menos, con los mismos hashes lógicos en las cinco fuentes y las tres repeticiones. La mediana del máximo RSS registrado por las corridas pasó de 664 a 818 MiB. Esta comparación mide backtests repetidos, no una corrida diaria aislada ni tiempo humano. Evidencia local: `~/earlyscript-data/trend-performance/benchmark-combined/`, `benchmark-summary.json` y `benchmark-memory.json`.

## Interpretar el seguimiento

El informe `earlyscript.backtest/3` exige capturas `complete` de todas las fuentes de verdad durante los 14 días posteriores al corte. Una captura `partial`, incluso de una muestra prevista, deja ese corte en el grupo parcial. `--truth hn` permite evaluar seguimiento en HN mientras GitHub y otras fuentes aportan candidatos. Esto mide coincidencia con actividad posterior de HN, no calidad universal de las tendencias.

P@5 sigue siendo condicional a los cortes donde ambos brazos emiten candidatos. El informe cuenta por separado los cortes vacíos. Si el candidato no emite ninguno en un corte completo donde el baseline sí emite, el veredicto es `worse` aunque los cortes emparejados tengan buena precisión.

Los registros recuperados después del corte, especialmente los seleccionados por popularidad actual, no reconstruyen necesariamente lo que se conocía entonces. El backtest es un replay retrospectivo. Las etiquetas asignan cada noticia a un único candidato: añadir candidatos puede cambiar las etiquetas de los anteriores. No interpretar estos resultados como validación prospectiva ni como etiquetas independientes del conjunto emitido.

Los informes de esquema 2 se conservan como evidencia histórica. `check --backtest ... --rerun` genera el esquema actual, pero informa que el hash cambió cuando cambian las reglas. No reemplaza ni aprueba silenciosamente el informe antiguo.

## Ciclo

1. `sources/`: un adaptador por fuente y día. `fixture` reproduce `<fuente>/<día>.jsonl` y `coverage.jsonl`; los adaptadores en vivo de HN y GitHub implementan la misma interfaz `SourceAdapter`.
2. Corte: el corte se aplica antes de abrir archivos. Solo se leen y se hashean `coverage.jsonl` y los archivos de días anteriores al corte, comparados con su entrada en `corpus-manifest.json`; los de días posteriores no se abren, aunque estén corruptos o sin permisos de lectura. Los ítems posteriores se filtran.
3. Embeddings: Qwen3-Embedding-0.6B ONNX q8 por transformers.js en procesos hijo. Caché SQLite (por defecto `~/earlyscript-data/embeddings/embeddings.sqlite`) con clave de modelo, revisión, dtype, pooling, lote, runtime con hilos, plataforma, arquitectura y hash del texto. El vector de un texto no depende de cuántos procesos ni hilos lo calculan.
4. Apilado por coseno mayor que 0,70 con ventana activa de 30 días, series por día con `known` según cobertura. Costo: cada ítem se compara con todas las señales activas, O(ítems × activas × 1024); en el corpus de referencia son 291 millones de cosenos. `cluster.ts` guarda los centroides activos en un `Float32Array` contiguo, recorre la primera mitad de las dimensiones de dos ítems a la vez y descarta un centroide en 1/2, 5/8, 3/4 y 7/8 de las dimensiones cuando la cota de Cauchy-Schwarz prueba que no supera el umbral. Las sumas conservan el orden de `dot()`, así que las señales son idénticas bit a bit a las de la versión directa (`testkit/cluster.reference.ts`). El apilado del corpus de referencia pasó de 593 s a 61 s en Beatriz.
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

No hacen falta claves. `GITHUB_TOKEN`, si existe, se envía solo a GitHub para ampliar su cuota. El cliente no guarda ni registra cabeceras, cuerpos de error ni credenciales. Hay una petición simultánea, pausas mínimas de 250 ms para HN y 6500 ms para GitHub, hasta tres reintentos con espera exponencial, respeto de `Retry-After` y del reinicio de cuota. El límite es 45 segundos por petición y cinco minutos por fuente y día. No se espera una cuota que exceda ese presupuesto. Un 429, o un 403 de cuota, con `Retry-After` o `x-ratelimit-reset` deja un bloqueo `blockedUntil` en el estado compartido de la fuente, medido con un reloj monótono. El bloqueo se conserva al pasar al día siguiente: ese día espera hasta que termine o, si no cabe en su presupuesto, queda `unavailable` sin hacer peticiones. El estado y las cabeceras se leen antes del cuerpo, y el JSON solo se interpreta en respuestas 2xx. El cuerpo se lee por trozos con un máximo de 4 MiB para HN y 2 MiB para GitHub (`MAX_RESPONSE_BYTES` en `src/sources/http.ts`); al superarlo, la petición se aborta y no se reintenta.

Un día HN `complete` se omite salvo con `--force`. Los demás días se pueden reintentar. Una captura incompleta queda `partial` si conserva ítems o `unavailable` si no tiene evidencia. El motivo se guarda en `note` y la captura sigue con los otros días. `coverage.jsonl` no tiene campo de motivo: los fallos de cuota y de tamaño mantienen el estado `unavailable` o `partial` y su `note` empieza por `rate_limited:` o `response_too_large:`. Los ítems previos se unen por ID con los nuevos. Las versiones reemplazadas se conservan por hash en `history/`, también en el manifiesto. Los archivos se reemplazan mediante renombre y `.collect.lock` impide escritores simultáneos. El comando rechaza un corpus cuyo manifiesto o archivos ya no coinciden. Si el proceso se interrumpe entre archivos, requiere revisar el corpus antes de continuar: no hay transacción que abarque todo el directorio.

Campos de captura. `written_at` del manifiesto usa el reloj real al escribir y queda fuera de `corpus_hash`, por lo que dos capturas con las mismas respuestas tienen el mismo `corpus_hash` pero un manifiesto distinto byte a byte. `retrieved_at` de cada ítem y de cada fila de cobertura es el momento de observación: sí está en los archivos y, por tanto, en sus SHA-256 y en `corpus_hash`. El hash solo se reproduce con las mismas respuestas y la misma hora de observación (en las pruebas, un reloj fijo). `corpus/1` no tiene `fetched_at`.

El fixture `src/testkit/hn-live-reference.jsonl` contiene 20 líneas públicas del corpus congelado de Earlywindow (`hn/2026-10-15.jsonl`), usadas para comprobar todos los campos de los ítems sin red.
