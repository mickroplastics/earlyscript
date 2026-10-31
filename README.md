# Earlyscript

Earlyscript es un estudio editorial para un operador que decide, cada mañana, de qué video hablar. Detecta qué temas crecen en comunidades técnicas públicas, los presenta como fichas de tendencia con evidencia enlazada y acompaña la escritura de un guion de video en un hilo de conversación con un agente de código, con la decisión final del operador registrada con utilidad, motivo y tiempos. Es un fork privado de [T3 Code](https://github.com/pingdotgg/t3code) (licencia MIT), tomado del commit `aa11ef6783` del 30 de octubre de 2026; el README original de T3 Code se conserva literalmente en [`docs/README-t3code.md`](docs/README-t3code.md); sus enlaces relativos se interpretaban desde la raíz del repositorio.

## Propósito académico y estado

Earlyscript es el prototipo del proyecto de titulación "Arnés agéntico basado en modelos de lenguaje y análisis semántico de tendencias para priorizar ideas de contenido en YouTube orientadas a la adquisición de miembros para SingulariDev" (Miguel Ángel Brito Espejo, Maestría en Inteligencia Artificial Aplicada, Universidad de Las Américas, 2026; auspiciante Bistec LLC). Sustituye como producto final a [Earlywindow](https://git.r.biste.cc/miguel/earlywindow), cuya aplicación de escritorio queda como antecedente y cuyo motor de tendencias se porta aquí.

Estado al 31 de octubre de 2026, sobre `main` `f75eebfae2`: están fusionados y verificados por un segundo modelo la capa de marca, las banderas que apagan telemetría y esconden funciones ajenas al estudio, la batería de pruebas en Linux, el motor de tendencias con fuentes en vivo, el validador del guion, la base editorial, el espacio Tendencias con títulos y resúmenes del asistente, la bandeja con sus tres acciones, el lector de corridas en el formato nativo del motor y en el de Earlywindow, el hilo de video (servidor y pantalla) y el espacio Resultados. La política que bloquea agentes en hilos manuales está implementada; la pantalla del modo manual y la corrida nocturna no están iniciadas. No se ha hecho todavía ningún ejercicio de evaluación humana; el espacio Resultados solo ha mostrado datos de prueba (resultado reportado, sin registro en el repositorio).

## Problema y solución

El fundador de SingulariDev investiga y prioriza ideas de video a mano, estima esa carga en más de 20 horas semanales y no conserva un registro que una señales, evidencia y decisiones. Earlyscript separa cuatro responsabilidades:

1. **Evidencia.** Adaptadores de solo lectura capturan historias de Hacker News y repositorios nuevos de GitHub, día a día, con fecha, URL, autor y texto acotado, en un corpus por archivos con manifiesto SHA-256.
2. **Cálculo.** Un motor determinista, sin modelo de lenguaje, embebe los textos con Qwen3-Embedding-0.6B en CPU, los apila por cercanía de coseno en señales, calcula series diarias, etapa (creciendo, estable, decayendo), afinidad con el perfil del canal y dos rankings (por volumen de siete días y por fórmula ponderada), y emite la unión de las 20 primeras tendencias de cada ranking, ordenada por volumen de siete días, con hasta 40 fichas distintas, cada una con evidencia. Cada corrida lleva huellas de configuración, corpus y resultado.
3. **Síntesis.** El asistente redacta, una vez por corrida, un título y un resumen de tres párrafos por tendencia, citando identificadores de evidencia; no cambia el orden ni el puntaje. En el hilo de video, el operador escribe el guion en un archivo Markdown con o sin agente; un validador cuenta afirmaciones y citas.
4. **Decisión.** Solo el operador decide (crear hilo de video, seguir observando o descartar una tendencia; aceptar, editar, rechazar o diferir un guion) con utilidad de 1 a 5, motivo obligatorio y tiempos por etapa. El agente no puede invocar ese camino.

El modelo de lenguaje no participa en recolectar, agrupar ni ordenar. Los modelos de embeddings y de lenguaje no se entrenan: se calibran umbrales, pesos y perfil.

## Requisitos y dependencias

- Linux x86_64 (Debian 13 probado) o macOS arm64. Node 26.12.1 y pnpm 12.14.0. Unos 2 GB de RAM por proceso de embeddings.
- Al menos un agente de código instalado y con sesión iniciada en la máquina: Claude Code o Codex. Earlyscript no pide claves de API: usa los agentes instalados, como T3 Code.
- Sin claves para las fuentes. `GITHUB_TOKEN` es opcional y solo amplía la cuota de GitHub.
- El modelo `onnx-community/Qwen3-Embedding-0.6B-ONNX` (revisión `c25a394`, q8) se descarga de Hugging Face en la primera corrida a `~/earlyscript-data/models/`.
- Dependencias de T3 Code para la batería completa en Linux: ver [`docs/dev-environment-linux.md`](docs/dev-environment-linux.md).

## Ejecución paso a paso

Desde la raíz del checkout. Si la terminal se abrió desde T3 Code, anteponer `env -u T3CODE_HOME` para no usar sus datos.

```sh
# 1. Instalar y comprobar
pnpm install --frozen-lockfile
pnpm es:typecheck
pnpm es:test            # pruebas de los paquetes propios y de los módulos que tocan

# 2. Capturar fuentes (HN y GitHub, por día UTC; --to excluye el día)
pnpm --filter @earlyscript/trend-engine engine collect \
  --corpus ~/earlyscript-data/corpus --sources hn,github \
  --from 2026-10-03 --to 2026-10-31

# 3. Crear el perfil del canal (ejemplo mínimo, no el perfil usado en las mediciones)
mkdir -p ~/earlyscript-data/profiles
cat > ~/earlyscript-data/profiles/ejemplo.json <<'JSON'
{
  "schema_version": "profile/1",
  "name": "SingulariDev",
  "audience": "Developers",
  "include": ["developer tools"],
  "exclude": []
}
JSON

# 4. Correr el motor con un corte y el perfil
pnpm --filter @earlyscript/trend-engine engine run \
  --corpus ~/earlyscript-data/corpus --cutoff 2026-10-31T00:00:00Z \
  --profile ~/earlyscript-data/profiles/ejemplo.json \
  --out ~/earlyscript-data/runs --workers 2

# 5. Volver a ejecutar una corrida y comparar huellas (sin --rerun solo recalcula la huella de las fichas existentes)
# Sustituir RUN_ID por la carpeta producida en el paso anterior.
pnpm --filter @earlyscript/trend-engine engine check \
  --run "$HOME/earlyscript-data/runs/RUN_ID" \
  --rerun --out "$HOME/earlyscript-data/reruns"

# 6. Validar un guion (rutas absolutas: pnpm ejecuta el script dentro del paquete)
pnpm --filter @earlyscript/editorial-script check \
  /ruta/absoluta/guion.md --dossier /ruta/absoluta/ficha.json

# 7. Arrancar el estudio
pnpm dev
```

El perfil del canal (`packages/editorial-contracts/src/profile.ts`) exige `schema_version` `profile/1`, `name`, `audience`, `include` con al menos un tema y `exclude`; `version` es opcional. Se versiona por hash en cada corrida. El guion exige los encabezados `# Hook`, bloques `# Block 1` en adelante y `# Close`, con `# Sources` opcional, y citas como `[itm_hn_50061234]`; el formato completo está en [`packages/editorial-script/README.md#formato`](packages/editorial-script/README.md#formato). `--dossier` recibe una ficha generada por el motor. Los puertos base del estudio son 14773 y 5743; pueden cambiar según el worktree, la configuración y la disponibilidad, así que hay que leer los puertos efectivos y la URL de emparejamiento en el log. En la interfaz, el espacio Tendencias lee las corridas de `~/earlyscript-data/runs/` y las importa a `editorial.sqlite`; el botón "Redactar todas las de esta corrida" pide al asistente los títulos y resúmenes.

Para empaquetar la aplicación de escritorio: `pnpm es:build` y después `pnpm dist:desktop:dmg:arm64` (macOS) o `pnpm dist:desktop:linux`. Las aplicaciones no están firmadas.

## Pipeline

```
fuentes (HN, GitHub) ──collect──▶ corpus/1 por día y fuente, manifiesto SHA-256
                                       │ corte
                                       ▼
   Qwen3 q8 en CPU ──▶ apilado por coseno 0,70 ──▶ series diarias ──▶ etapa y afinidad
                                       │
                                       ▼
          dos rankings (items_7d y fórmula) ──▶ run.json + fichas (earlyscript.dossier/1)
                                       │ importador
                                       ▼
   editorial.sqlite ◀── espacio Tendencias (título y resumen del asistente) ── decisión
                                       │ crear hilo de video
                                       ▼
   hilo de T3 Code con agente ──▶ guion Markdown con versiones ──▶ script_check ──▶ decisión
                                       │
                                       ▼
                              espacio Resultados (descriptivo)
```

El método del motor es el de Earlywindow `engine.v0.02`: texto de título más 1.000 caracteres, filtro de idioma por proporción de letras ASCII, duplicados por URL, apilado en orden de publicación con ventana activa de 30 días, crecimiento `ln((ítems de 7 días + 1) / (ítems de los 7 previos + 1))`, fórmula `0,5 × crecimiento + 0,2 × ln(1 + autores) + 0,3 × afinidad`. Los parámetros, incluido el máximo de 20 por ranking, están en [`packages/trend-engine/config/engine.v1.json`](packages/trend-engine/config/engine.v1.json) y se declaran como hipótesis en cada `run.json`. Detalle en [`packages/trend-engine/README.md`](packages/trend-engine/README.md).

## Organización del repositorio

| Carpeta                                                          | Contenido                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/editorial-contracts/`                                  | Esquemas de ítem, fuente, corrida, ficha de tendencia, perfil y decisión, y lector del formato de Earlywindow                                                                                                                               |
| `packages/trend-engine/`                                         | Motor: fuentes, corpus, embeddings, apilado, series, rankings, corrida y verificación; CLI `engine`                                                                                                                                         |
| `packages/editorial-script/`                                     | Validador del guion; CLI `check`                                                                                                                                                                                                            |
| `apps/server/src/editorial/`                                     | Base `editorial.sqlite` con migraciones 001 a 006, servicios de lectura, comando, importación, presentaciones, resultados, reloj de trabajo e hilo de video; política que bloquea agentes en hilos manuales; herramienta MCP `script_check` |
| `apps/web/src/editorial/`                                        | Barra lateral con espacios, bandeja y ficha de tendencia, panel de decisión, reloj, resultados                                                                                                                                              |
| `apps/server/src/earlyscript/`, `apps/desktop/src/earlyscript/`  | Banderas que apagan telemetría, analítica y funciones escondidas en la capa más alta del servidor                                                                                                                                           |
| `packages/shared/src/earlyscriptBrand.ts`, `earlyscriptFlags.ts` | Marca, puertos, directorio base y banderas                                                                                                                                                                                                  |
| `scripts/earlyscript/`                                           | Batería rápida `es:*` y comprobación de alcance                                                                                                                                                                                             |
| `docs/upstream-divergence.md`                                    | Registro archivo por archivo de lo que difiere de T3 Code                                                                                                                                                                                   |
| `docs/dev-environment-linux.md`                                  | Preparación del entorno y resultados de la batería en Linux                                                                                                                                                                                 |
| Resto del árbol                                                  | T3 Code sin cambios o con enganches de una línea registrados                                                                                                                                                                                |

Los datos viven fuera del repositorio, en `~/earlyscript-data/`: `corpus/`, `runs/`, `models/`, `embeddings/` (caché SQLite por modelo, plataforma y texto) y `profiles/`. No se versionan corpus, corridas, bases ni credenciales.

## Pruebas y evidencia

- `pnpm es:test` ejecuta las pruebas de los paquetes propios y de los módulos de T3 Code que tocan; la batería completa de upstream (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`) es la compuerta prevista de cada fusión (`docs/dev-environment-linux.md`). Las pruebas de equivalencia del apilado acelerado con la versión directa están en `packages/trend-engine/src/cluster.test.ts`.
- Cada unidad de trabajo tiene rama propia, informe y veredicto de un segundo modelo en solo lectura ("apto", "apto con correcciones", "no apto") antes de fusionar; los informes y los registros de ejecución se conservan fuera del árbol versionado, en `~/earlyscript-data/` y en la base documental de la tesis.
- Corrida real del 31 de octubre de 2026, con su `run.json` conservado como fixture en `apps/server/src/editorial/fixtures/native-runs/`: 28.593 registros leídos (28 días completos de HN y 28 parciales de GitHub), 26.037 textos embebidos, 8.776 señales, 99 en crecimiento, 15 fichas elegibles, 374 s. El desglose por fuente (28.311 de HN y 282 de GitHub) y las 15 fichas completas están solo en la corrida fuera del repositorio (`~/earlyscript-data/runs/run_20261031_20261031T003855_5e57bf/`) y en el informe de la tesis.
- Comparación con Earlywindow sobre el mismo corpus, corte y perfil, documentada en [`docs/upstream-divergence.md`](docs/upstream-divergence.md) (sección del motor, paso 1): 19 fichas frente a 18; coinciden 3 de 5 en el top 5 por volumen; los vectores de Linux no reproducen los de macOS (coseno mediano 0,965 para el mismo texto).
- Resultados reportados, no verificables desde el repositorio (la evidencia se conserva fuera del árbol versionado y en el informe de la tesis): typecheck de 39 paquetes y 122 pruebas editoriales en 15 archivos sobre `main` el 31 de octubre; batería completa en 630 s en un servidor Linux de 22 núcleos y 706 s en una Mac mini; huella lógica de la corrida de referencia reproducida tres veces; 401 casos de equivalencia del apilado; 3 fichas redactadas con `claude-haiku-5-5` en 12 a 22 s sin atribuciones inventadas en la revisión; retrospectiva y robustez medidas en Earlywindow en macOS (P@5 de 0,95 frente a 1,00 de la línea base por volumen; orden estable ante ±20 % en los pesos; selección sensible al umbral de apilado), no repetidas aquí.

## Fuentes y condiciones de uso

- Hacker News, por la API pública de Algolia, sin clave: historias sin comentarios. Los términos de Y Combinator restringen el uso comercial y la redistribución del contenido; el corpus se guarda en local para evaluación académica y no se redistribuye.
- GitHub, por la API de búsqueda de repositorios, sin clave: repositorios creados cada día con 20 estrellas o más, primera página de 100 ordenada por estrellas actuales; cobertura siempre parcial.
- Los textos contienen nombres públicos de autores y no son anónimos. No se recogen comentarios ni datos de cuentas. El corpus se puede borrar por fuente y antigüedad.
- Lo que se envía al proveedor del agente: para los títulos, los términos, conteos y evidencia de cada ficha; en el hilo de video, lo que el operador escriba o adjunte. Telemetría, analítica de terceros y comprobación de actualizaciones de T3 Code están apagadas.

## Sesgos y limitaciones conocidas

Dos fuentes técnicas en inglés dominadas por anuncios de grandes proveedores; el filtro de idioma deja pasar textos en español; la mayoría de las historias de HN no tienen cuerpo, así que la evidencia suele ser un título; la selección depende del umbral de apilado y de la plataforma de los vectores; el ranking ponderado no supera al orden por volumen en la retrospectiva de Earlywindow; la hipótesis de avisar una o dos semanas antes no quedó respaldada. Las fichas son apoyo de lectura, no predicción, y las métricas de los videos se registran a mano y de forma descriptiva.

## Desarrollo

Reglas del fork en [`AGENTS.md`](AGENTS.md): fusión regular de upstream, código aditivo, capa de marca fina, funciones escondidas por banderas, registro de divergencia. Entorno y baterías en [`docs/dev-environment-linux.md`](docs/dev-environment-linux.md). Earlyscript convive con un T3 Code instalado porque usa `~/.earlyscript`, los puertos 4773, 14773 y 5743, el esquema `earlyscript://` y el binario `earlyscript`; todo está en `packages/shared/src/earlyscriptBrand.ts`. Las variables `T3CODE_HOME`, `T3CODE_PORT`, `T3CODE_PORT_OFFSET` y `PORT` conservan su nombre.
