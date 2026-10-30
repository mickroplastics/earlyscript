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

1. `sources/`: un adaptador por fuente y día. `fixture` reproduce `<fuente>/<día>.jsonl` y `coverage.jsonl`; los adaptadores en vivo de HN y GitHub implementarán la misma interfaz `SourceAdapter`.
2. Corte: el corte se aplica antes de abrir archivos. Solo se leen y se hashean `coverage.jsonl` y los archivos de días anteriores al corte, comparados con su entrada en `corpus-manifest.json`; los de días posteriores no se abren, aunque estén corruptos o sin permisos de lectura. Los ítems posteriores se filtran.
3. Embeddings: Qwen3-Embedding-0.6B ONNX q8 por transformers.js en procesos hijo. Caché SQLite (por defecto `~/earlyscript-data/embeddings/embeddings.sqlite`) con clave de modelo, revisión, dtype, pooling, lote, runtime con hilos, plataforma, arquitectura y hash del texto. El vector de un texto no depende de cuántos procesos ni hilos lo calculan.
4. Apilado por coseno mayor que 0,70 con ventana activa de 30 días, series por día con `known` según cobertura.
5. Dos rankings sobre las tendencias elegibles (creciendo y dentro del perfil): `baseline.items_7d` y `weighted_sum.v0.01` (crecimiento 0,5, autores 0,2, afinidad 0,3). Los expedientes se escriben en orden de línea base.
6. Cobertura: un día sin datos queda `known: false` y en `data_gaps`; con `stage.coverage_rule: per_source` no deja la lista vacía. Los días `partial` de GitHub son su muestra declarada y no cuentan como hueco.
7. `run.json` lleva corte, configuración y su hash, `corpus.corpus_used_hash` (archivos de días y filas de cobertura anteriores al corte; es el `engine.corpus_hash` de cada expediente y entra en `logical_hash`), `corpus.corpus_manifest_hash` (identidad del corpus congelado tomada del manifiesto), plataforma, cobertura, tiempos, memoria pico y `logical_hash`: SHA-256 de los expedientes sin `run_id`, `dossier_id` ni `created_at`. `stats.signals_hash` cubre todas las señales, no solo las emitidas.
