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

## Motor v2: relevancia editorial aprendida

`config/engine.v2.json` (`earlyscript.engine.v2`) no cambia v1: con `config/engine.v1.json` el `logical_hash` es el mismo que antes. v2 añade, sin modelo de lenguaje en tiempo de corrida:

- `relevance`: sonda logística L2 sobre el vector Qwen de cada ítem (`config/relevance.v1.json`, nombrada por su SHA-256 en la configuración, así que `config_hash` cubre los pesos). Relevancia del ítem = `sigmoid(w·x + b)`; la del tema, la media de sus ítems de los últimos 7 días. Un tema es elegible si crece y su relevancia es ≥ `signal_min`; `profile_gate: false` quita el filtro de afinidad de perfil.
- Serie sobre ítems relevantes (≥ `item_min`) con `stage.coverage_rule: equivalent`: cada fuente cuenta solo en días capturados por completo (o su muestra declarada) y solo si ambas ventanas de 7 días tienen alguno; los conteos pasan a tasas por día × 7. Una fuente que empieza a capturar dentro de la última ventana no genera crecimiento. Los campos `trend.*` conservan su sentido de v1; los de v2 están en `relevance`.
- `emit.dedup_cosine`: un tema con coseno de centroide mayor que el umbral con otro mejor situado en el ranking ponderado se emite en `related` de ese expediente y no ocupa puesto. `emit.min_dossiers`: si hay menos elegibles, se completan con los temas en crecimiento más relevantes bajo `signal_min` y después con estables con ítems suficientes, marcados `eligibility: "backfill"` y ordenados al final.
- `relevance.aggregate` (`mean`, `share` = fracción de ítems de 7 días con relevancia ≥ `item_min`, `trimmed_mean` sin el quinto más alto ni el más bajo) y `relevance.min_relevant_distinct` (ítems relevantes de 7 días con títulos distintos, sin contar dígitos: las versiones de un paquete cuentan una vez).
- `relevance.novelty`: un tema que estuvo en el top `top` de alguno de los `lookback_days` cortes anteriores (recalculados con los ítems anteriores a cada uno, sin esta regla) solo ocupa puesto si sus ítems relevantes por día desde ese corte llegan a `growth_ratio` veces su tasa de los 7 días previos; si no, solo puede rellenar al final.
- `weighted_sum.v0.02`: crecimiento 0,25, relevancia 1,0 y ln(1 + ítems relevantes en 7 días) 0,15, sin el término de autores. Cada expediente lleva la relevancia como componente y la de cada evidencia.

Herramientas fuera del motor, en `src/tools/` (se ejecutan con `node src/tools/<archivo>.ts`):

- `judge.ts`: juez editorial con el CLI `claude -p` de la suscripción, sin herramientas, web, ajustes ni MCP. Cada versión congela rúbrica, modelo y etiquetas en `judge/judge.vN.json` (el archivo guarda el hash de la rúbrica y la carga falla si cambió). v1: yes/no/unsure, no pasó la calibración con Miguel. v2: core/adjacent/no/unsure, adoptado (acuerdo 0,838, κ 0,656 en la mitad de validación). v3: revisión descartada. Caché por hash de (rúbrica, modelo, texto) y cada llamada con su prompt y respuesta.
- `relevance-sample.ts`, `relevance-train.ts`: muestra estratificada por fuente y entrenamiento con validación cruzada por bloques de días, con objetivo binario o graduado (`--targets core=1,adjacent=0.6,no=0`); escriben el modelo y un informe con la separación frente a la afinidad de perfil. El formateador reempaqueta los pesos: registrar el hash del archivo ya formateado.
- `calibration-items.ts`, `calibration-agreement.ts`: tarjetas de ítem para calibrar al juez; división fija revisión/validación de las etiquetas exportadas por la página de U1 (se valida `cards_hash`) y compuerta: todas las tarjetas respondidas, el juez resuelve al menos el 80 % de lo que resolvió el operador, acuerdo ≥ 0,80 y κ ≥ 0,5 entre resueltas.
- `training-families.ts`: registro de familias de entrenamiento (señales con algún ítem de entrenamiento, con su centroide) para cruzar con desarrollo y prueba.
- `dev-compare.ts`: comparación de variantes en desarrollo con el juez (P@5 con denominador 5). No es la evaluación de referencia.

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

## Evaluación editorial (`eval-editorial`, protocolo P1.1)

Mide si el motor propone, en el corte, temas sobre los que SingulariDev haría un video. Cada brazo es una configuración del motor más un método de orden: `--arm <nombre>=<config.json>[:weighted|:baseline|:keywords=<términos.json>]`.

- `--references` añade:
  - R1: `engine.v1.json:weighted`.
  - R2: `engine.v1.json:baseline`.
  - R3: `editorial-eval/engine.v1-noprofile.json:baseline`. Usa umbrales de perfil inalcanzables y emite todas las tendencias que crecen.
  - R4: palabras clave de `editorial-eval/keywords.v1.json`. La lista se escribió el 5 de noviembre de 2026, antes de ordenar ningún corte de prueba. Se aplica sobre los términos del expediente y los títulos de los 7 días previos, con orden `items_7d`.
- `--candidate-v2` añade C: `engine.v2.json:weighted`.

Ninguno cambia código del motor. `engine.v1.json` sigue dando el mismo `logical_hash`.

```sh
engine eval-editorial pool --corpus <dir> --profile <perfil> --out <dir> --cutoffs 2026-10-17..2026-10-26 --references --candidate-v2 --cache <sqlite> --workers 3
engine eval-editorial cards --universe <dir>/universe.json --out <dir> --name calibracion-60 --cutoffs … --sample 60 --seed 20261105
engine eval-editorial judge --cards <dir>/cards.jsonl --entries-out entries.jsonl        # entradas para node src/tools/judge.ts
engine eval-editorial judge --cards <dir>/cards.jsonl --judged salida.jsonl --out labels-juez.json --universe <dir>/universe.json [--judge judge/judge.vN.json]
engine eval-editorial hn-labels --universe <dir>/universe.json --corpus <dir> --out labels-hn.json --cache <sqlite> --cache-only
engine eval-editorial freeze --ledger <ledger.jsonl> --profile <perfil> --references --candidate-v2 --registry dev=<dev>/families.json --file config/relevance.v1.json --file judge/judge.v1.json …
engine eval-editorial pool … --ledger <ledger.jsonl> --registry dev=<dev>/families.json      # prueba: verifica la congelación y sella
engine eval-editorial score --universe … --rankings … --labels labels.json [--migrate-labels <labels>=<tarjetas.jsonl>] --out <dir> --dev <días> | --retro <días> --prospective <días> --ledger … --candidate C
engine eval-editorial capture --corpus <dir> --ledger <ledger.jsonl> --snapshots <dir> --first-day … --last-day … [--seed-from <corpus>]
```

### `pool`

- Corre el motor una vez por corte y por configuración distinta. Los brazos que comparten configuración comparten la corrida.
- Continúa el apilado de forma incremental entre cortes.
- Reutiliza una corrida (`runs/<corte>/<config>/emitted.json`) solo si coinciden el corte, la configuración, el perfil, el embedder, el corpus y el hash del código del motor (`ENGINE_SOURCE_HASH`, los `.ts` de `src` sin pruebas, `tools`, `testkit` ni `editorial-*`).
- Toma el top 5 de cada brazo y fusiona en una **oportunidad** (tema, corte) los puestos de un mismo corte que son el mismo tema. La fusión usa solo los datos de ese corte.
- Las oportunidades de cortes distintos forman **familias**. Las familias sirven únicamente para dos cosas: el bootstrap y separar temas nuevos de recurrentes. Ni una etiqueta ni un crédito pasan de un corte a otro.
- Escribe `universe.json` y `rankings.json`, con el hash de su parte lógica. También escribe `centroids.json`, las tarjetas y `families.json`.
- `families.json` es el registro congelado de los miembros del top 5, con centroide, ítems y términos. Otro `pool` lo importa con `--registry dev=<ruta>` y marca en `seen_in.dev` cada tema que coincide con una familia de desarrollo según la misma regla, usando la rareza del corte del tema. Con `--registry train=…` hace lo mismo para el registro de familias de entrenamiento, que debe tener el mismo formato (`earlyscript.editorial-families/1`).

### Regla de mismo tema

Dos puestos son el mismo tema si se cumple una de estas condiciones:

- comparten al menos la mitad de los ítems del menor;
- el coseno de sus centroides es ≥ 0,80 **y** comparten al menos dos términos principales raros. Un término es raro si aparece en ≤ 1 % de los ítems del corpus de los 30 días anteriores al corte.

P1 pedía solo coseno ≥ 0,80. En el desarrollo eso fundía grupos sin relación, porque los grupos de 30 días tienen centroides cercanos a la media del corpus. Por ejemplo, «prediction markets» y «attention cache compression» daban 0,87, mientras los dos grupos del mismo arresto en OpenAI daban 0,84. La relación se cierra por componentes conexas.

### Tarjeta de tema (ciega)

- Muestra los términos del expediente ancla: el puesto con menor `trend_id|sha256(centroide)`.
- Muestra los 5 ítems más recientes publicados antes del corte, tomados de la unión de miembros, con desempate por id.
- Muestra la fecha del corte.
- No muestra puntuación, posición, brazo ni familia.

Al añadir un brazo, el contenido de una tarjeta puede cambiar. Por eso `score` acepta solo etiquetas del mismo `universe_hash`. Para etiquetas de otro universo existe la migración explícita `--migrate-labels <labels>=<tarjetas.jsonl>`:

- el `sha256` del archivo de tarjetas debe ser el `cards_hash` de las etiquetas;
- una etiqueta pasa solo si su tarjeta es idéntica (corte, términos y titulares);
- el resto se descarta y se cuenta.

`cards.html` es la página de etiquetado. Admite tarjetas de ítem (`unit: "item"`). `--sample` reparte la muestra por turnos entre familias.

### `score`

Las reglas son de P1.1, con las correcciones de la verificación de Sol.

- **Denominador 5.** Valen 0:
  - un puesto vacío;
  - una tarjeta en «no sé», pendiente o sin juicio;
  - la segunda aparición de la **misma oportunidad** en el top 5;
  - en la retrospectiva, un puesto cuyo soporte **propio** está formado solo por ítems de GitHub o Hugging Face recuperados después del corte (B6). El soporte son los ítems del miembro de ese brazo en los 7 días previos, o sus 5 más recientes si no tiene. Nunca se mira la tarjeta compartida.
- **Medidas secundarias.** Informa además:
  - la cota con las dudas como sí;
  - la precisión entre las respuestas resueltas;
  - P@5 entre los puestos con etiqueta, junto a su cobertura;
  - las familias nuevas y las recurrentes;
  - la dependencia de fuentes con la semana previa incompleta;
  - la cobertura por fuente.
- **Intervalos.**
  - Bootstrap pareado por familias, con semilla fija.
  - Bonferroni para las diferencias contra las referencias.
  - Sensibilidad con bloques móviles de 7 días de calendario. El inicio se sortea entre el primer día menos 6 y el último. Un bloque sobre un hueco no aporta nada. Los extremos del calendario no se unen.
- **Cortes pedidos.** Un corte que no está en el universo es un error. Una partición de prueba sin `--registry dev` en su `pool` ni `--dev` en el mismo universo también es un error.
- **Con `--ledger`.** `score` y `cards` verifican, en este orden:
  1. la cadena del libro;
  2. que la última congelación no esté vacía;
  3. que cada archivo congelado conserve su hash;
  4. que coincidan los brazos (configuraciones efectivas, métodos y palabras clave), el perfil, el código del motor y los registros;
  5. que cada corte prospectivo haya leído su captura (`corpus_hash` y `closed_at`);
  6. que el par exacto universo/rankings esté sellado después de esa congelación.

  Además, un corte prospectivo cuenta solo si su captura cerró después de la congelación.

### `hn-labels`

Da la etiqueta de seguimiento en HN a cada oportunidad, sin competencia entre temas. Un negativo queda `pending` hasta tener todos los días del seguimiento capturados como `complete`.

### Modificación del protocolo sobre el corte operativo (U1-S1)

El motor sigue cortando a las 00:00 UTC: publicaciones, ventanas de 7 días y evidencia. En un corte prospectivo, `closed_at` del asiento de captura es el instante de disponibilidad: los datos y el ranking existen desde entonces. P1.1 decía que el corte operativo es `closed_at`. Esta implementación lo aplica en dos lugares:

- la congelación debe preceder a `closed_at`;
- el seguimiento HN de un corte prospectivo empieza en `closed_at`, de modo que una historia publicada entre las 00:00 y el cierre no cuenta como posterior.

Las ventanas no se calculan desde `closed_at`.

### Captura prospectiva

`capture` hace, en orden:

1. Captura el día UTC anterior, ya cerrado.
2. Reintenta una vez Wikipedia del día previo si quedó `unavailable`.
3. Omite y registra (`skipped_duplicates`) cualquier ítem cuyo id ya existe en otro día de la misma fuente. Hugging Face llegó a devolver el mismo modelo dos días, y `collect` lo guardaría dos veces, lo que rompe toda lectura posterior.
4. Comprueba que no quedan ids repetidos (`duplicate_ids_after`).
5. Hace una instantánea con enlaces duros.
6. Añade el asiento encadenado al libro.

`pool --ledger` lee esa instantánea en los cortes prospectivos.

### Etiqueta graduada y consejo, ronda 2a

**Rúbrica sellada.** La página de etiquetado muestra el texto de `config/editorial-eval/label-rubric.v1.md`: la pregunta de los próximos 7 días, las definiciones de núcleo y adyacente con dos ejemplos cada una, y la regla «si dudas entre núcleo y adyacente, marca adyacente». Teclas: `1` núcleo, `2` adyacente, `n` no, `?` no sé. La exportación lleva `label` (`yes`/`no`/`unsure`), `grade` (`core`/`adjacent`/null) y `rubric_sha256`. `freeze-and-test.sh` incluye el archivo de la rúbrica en el asiento `freeze`.

**G@5.** Por puesto, núcleo vale 1, adyacente 0,5 y lo demás 0. El resultado se divide entre 5 y siguen las mismas reglas de ceros, intervalos y Bonferroni. Se cumple G@5 = 0,5 × P@5 + 0,5 × núcleo@5. Una etiqueta sin grado, anterior a la graduación, vale para P@5; si algún sí del conjunto no tiene grado, G@5 queda vacía. `score` informa además:

- la sensibilidad descriptiva con adyacente a 0,3 y a 0,7;
- G@5 sin la familia que más aporta, con los puestos de esa familia valiendo 0;
- en cada comparación, la diferencia de G@5 sin la familia que más aporta a esa diferencia;
- la precisión binaria condicional en familias ausentes de los registros de desarrollo y entrenamiento, con aciertos, puestos y número de familias. Dudas, duplicados y puestos B6 valen 0. Se marca «no evaluable» si no hay puestos o falta el registro de entrenamiento.

`--partition <nombre>=<días>` añade particiones con nombre, por ejemplo septiembre y del 27 de octubre al 4 de noviembre, junto a la retrospectiva, la prospectiva y su agregado. B6 se aplica a todo corte retrospectivo, en cualquier partición.

**Repeticiones a ciegas.** `cards --repeat 10` repite 10 tarjetas con el mismo contenido y otro `card_id`. Cada copia queda en una posición elegida con semilla fija, al menos 20 tarjetas después de su original. `score` reconoce la copia porque su `card_id` no es el del tema. La copia nunca entra en las métricas: cuenta la primera aparición. La copia solo sirve para informar la consistencia de quien etiqueta, de tres formas: binaria, graduada y núcleo frente al resto.

**Memoria de novedad de F.** F no guarda estado entre corridas. Cada corrida recalcula, desde sus propias señales, si cada tema estuvo en el top 5 de los 7 días previos (`priorTopDays` en `run.ts`). Para cada uno de esos días filtra los miembros anteriores; el apilado es en línea, así que son exactamente los miembros de ese día. La relevancia se calcula por ítem. Con cortes espaciados no hacen falta días intermedios en `pool`. Una prueba comprueba que el mismo corte da el mismo `logical_hash` y el mismo ranking en cuatro casos: solo, junto con otros cortes en cualquier orden, reutilizado desde la caché de corridas y con `runEngine` directo.

**Una regla de tema para U1 y U2.**

- La deduplicación de F al emitir (`rank.ts` `dedupe`) pliega un tema cuyo centroide tiene coseno > 0,80 con uno ya conservado.
- La regla de esta evaluación funde con coseno > 0,80 más dos términos raros, o con la mitad de los ítems compartidos.
- Dentro de una corrida las señales no comparten ítems. Por eso todo par que esta regla llama el mismo tema en un mismo ranking ya fue plegado por F, y el top 5 de F no puede tener duplicados según esta regla. Lo comprueba una prueba con fixtures.
- Entre cortes, y entre configuraciones distintas, manda la regla de esta evaluación, que es la que define oportunidades y familias.
