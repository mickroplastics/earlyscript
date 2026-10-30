# Entorno de desarrollo en Linux

Qué hace falta para que la batería de T3 Code pase en el LXC `agents` (Debian 13.7, x86_64, 8 núcleos, 128 GiB) y cómo se reparte entre la batería completa y la rápida de Earlyscript. Medido el 30 de octubre de 2026 sobre la base de upstream `aa11ef6783`.

## Preparación desde un checkout nuevo

En Debian 13 x86_64, desde la raíz del checkout. Los pasos de sistema y de Chromium se hacen una vez por máquina; los demás, una vez por checkout o worktree.

```sh
export PATH="$HOME/.local/opt/node-26.12.1/bin:$PATH"   # Node 26.12.1 y pnpm 12.14.0
sudo apt-get install -y build-essential xvfb pkg-config libsecret-1-dev
pnpm install --frozen-lockfile
pnpm --filter @t3tools/desktop run ensure:electron       # descarga Electron a ~/.cache/electron si falta
node apps/web/node_modules/playwright/cli.js install --only-shell chromium
pnpm es:check-scope
```

El CI de upstream instala con `vp install`, que respeta el lockfile, y ejecuta `ensure:electron` con `vp run --filter @t3tools/desktop ensure:electron`. Si `ldd` sobre el Chromium descargado muestra bibliotecas ausentes, ejecutar `node apps/web/node_modules/playwright/cli.js install-deps chromium`.

## Requisitos en el LXC `agents`

Ya presentes en el LXC antes de este trabajo: Node `26.12.1` en `~/.local/opt/node-26.12.1/bin`, pnpm `12.14.0`, `build-essential` 12.12 (`gcc` 14.2.0), `xvfb` 21.1.16 y la caché de Electron en `~/.cache/electron`.

Instalado para la batería (son los mismos pasos que hace el CI de upstream en `.github/workflows/ci.yml`):

| Paso                                                                         | Versión instalada                                                                                                                                    | Lo necesita                                                                                                                                      |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sudo apt-get install -y pkg-config libsecret-1-dev`                         | `pkg-config` 1.8.1-4, `libsecret-1-dev` 0.21.7-1 (arrastra `libglib2.0-dev` 2.84.4-3~deb13u5, `libgcrypt20-dev` 1.11.0-7+deb13u1 y sus dependencias) | `apps/desktop/scripts/browser-secret-native.test.mjs` compila el ayudante nativo `native/browser-secret` contra libsecret.                       |
| `node apps/web/node_modules/playwright/cli.js install --only-shell chromium` | Chrome Headless Shell 148.0.7778.96 (Playwright `1.60.0`, revisión `chromium-headless-shell` 1223) en `~/.cache/ms-playwright`                       | Proyecto `browser` de `apps/web` y `apps/server/src/preview/ServerBrowserPage.test.ts`. `apps/server` usa la misma versión de `playwright-core`. |

`ldd` no encontró bibliotecas ausentes en el binario de Chromium, así que no hizo falta `playwright install-deps`. Si tras una actualización de Playwright falta alguna, el CI ejecuta `node apps/web/node_modules/playwright/cli.js install-deps chromium`.

## Batería completa y batería rápida

La batería completa son los scripts de upstream sin cambios, sobre todo el workspace: `pnpm typecheck`, `pnpm lint`, `pnpm test` y `pnpm build`. Es la compuerta de cada fusión con upstream.

La batería rápida son los scripts `es:*` del `package.json` raíz, para el ciclo de cada cambio:

| Script            | Alcance                                                                                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `es:typecheck`    | Todo el workspace (`vp run typecheck`). Barato con la caché de `vp` y detecta incompatibilidades de tipos en paquetes que no probamos.                                                                                                                                 |
| `es:lint`         | Todo el workspace (`vp run lint`).                                                                                                                                                                                                                                     |
| `es:test`         | Pruebas de `scripts/earlyscript/scope.test.ts`, comprobación de alcance y después `test` solo en `include` de `scripts/earlyscript/packages.json`. `apps/web` y `apps/server` van en pasadas propias. Es la orden para cerrar una unidad de trabajo.                   |
| `es:test:changed` | Comprobación de alcance y después `check:changed` de upstream, que formatea, revisa, compila y prueba solo lo afectado por los cambios frente a la base de fusión con `origin/main`. Admite otra referencia: `pnpm es:test:changed <ref>`. Es la orden de cada cambio. |
| `es:build`        | Comprobación de alcance y después `build` solo en `include`.                                                                                                                                                                                                           |
| `es:check-scope`  | Solo la comprobación de alcance.                                                                                                                                                                                                                                       |

`scripts/earlyscript/packages.json` clasifica cada paquete del workspace en `include` o `exclude`, con su motivo en una línea. La comprobación falla si un paquete no está clasificado, si la lista nombra uno que ya no existe o si un paquete fuera de `include` importa algo de las carpetas propias de Earlyscript (`packages/editorial-*`, `packages/trend-engine`, `packages/earlywindow-engine`, `apps/server/src/editorial`, `apps/web/src/editorial`). Cuando upstream añada un paquete, `es:test` falla hasta que se clasifique.

La lista no es el cierre completo por dependencias. `apps/server` y `packages/client-runtime` importan todos los proveedores y todas las forjas, así que el cierre sería el workspace entero. Se corta en la frontera de proveedores y forjas: Earlyscript ejecuta Codex y Claude (dentro de `apps/server/src/provider`) y Pi. Lo que se deja fuera sigue cubierto por `es:typecheck`, `es:lint` y la batería completa.

## Resultados por paquete

Cada paquete se ejecutó por separado (`pnpm test` dentro de su carpeta), para que un fallo no oculte los demás. «Antes» es el LXC sin los requisitos; «después», con ellos. Evidencia en `~/earlyscript-data/build-scope/{baseline,after}/`.

| Paquete                                | Antes                                | Después                          | Nota                                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`                         | **falla**: 897 de 907, 10 omitidas   | pasa: 907 de 907                 | Antes faltaba `pkg-config`; el archivo del ayudante libsecret no compiló y sus 10 pruebas quedaron omitidas.                                                                                             |
| `apps/mobile`                          | pasa: 3036 de 3036                   | pasa: 3036 de 3036               |                                                                                                                                                                                                          |
| `apps/server`                          | **falla**: 5361 de 5383, 22 omitidas | pasa: 5379 de 5383, 4 omitidas   | Antes faltaba Chromium: `ServerBrowserPage.test.ts` falló y omitió 18 pruebas.                                                                                                                           |
| `apps/web`                             | **falla**: 4368 de 4368              | **falla**: 4864 de 4865, 1 falla | Antes el proyecto `browser` no arrancó sin Chromium: 324 de 434 archivos y 4.368 pruebas contadas. Después falló una aserción de `OpenInPicker.browser.test.tsx`; repetido solo pasó 3 de 3 (ver abajo). |
| `evals`                                | pasa: 437 de 437                     | pasa: 437 de 437                 |                                                                                                                                                                                                          |
| `infra/relay`                          | pasa: 300 de 300                     | pasa: 300 de 300                 |                                                                                                                                                                                                          |
| `infra/task-cache`                     | pasa: 41 de 41                       | pasa: 41 de 41                   |                                                                                                                                                                                                          |
| `oxlint-plugin-t3code`                 | pasa: 379 de 379                     | pasa: 379 de 379                 |                                                                                                                                                                                                          |
| `packages/client-runtime`              | pasa: 1479 de 1479                   | pasa: 1479 de 1479               |                                                                                                                                                                                                          |
| `packages/contracts`                   | pasa: 151 de 151                     | pasa: 151 de 151                 |                                                                                                                                                                                                          |
| `packages/effect-acp`                  | pasa: 64 de 64                       | pasa: 64 de 64                   |                                                                                                                                                                                                          |
| `packages/effect-codex-app-server`     | pasa: 28 de 28                       | pasa: 28 de 28                   |                                                                                                                                                                                                          |
| `packages/provider-acp`                | pasa: 89 de 89                       | pasa: 89 de 89                   |                                                                                                                                                                                                          |
| `packages/provider-acp-registry`       | pasa: 57 de 57                       | pasa: 57 de 57                   |                                                                                                                                                                                                          |
| `packages/provider-core`               | pasa: 155 de 155                     | pasa: 155 de 155                 |                                                                                                                                                                                                          |
| `packages/provider-cursor`             | pasa: 93 de 93                       | pasa: 93 de 93                   |                                                                                                                                                                                                          |
| `packages/provider-fx`                 | pasa: 5 de 5                         | pasa: 5 de 5                     |                                                                                                                                                                                                          |
| `packages/provider-grok`               | pasa: 83 de 83                       | pasa: 83 de 83                   |                                                                                                                                                                                                          |
| `packages/provider-muse`               | pasa: 89 de 89                       | pasa: 89 de 89                   |                                                                                                                                                                                                          |
| `packages/provider-opencode`           | pasa: 140 de 140                     | pasa: 140 de 140                 |                                                                                                                                                                                                          |
| `packages/provider-pi`                 | pasa: 129 de 129                     | pasa: 129 de 129                 |                                                                                                                                                                                                          |
| `packages/shared`                      | pasa: 1101 de 1103, 2 omitidas       | pasa: 1101 de 1103, 2 omitidas   |                                                                                                                                                                                                          |
| `packages/source-control-azure-devops` | pasa: 100 de 100                     | pasa: 100 de 100                 |                                                                                                                                                                                                          |
| `packages/source-control-bitbucket`    | pasa: 90 de 90                       | pasa: 90 de 90                   |                                                                                                                                                                                                          |
| `packages/source-control-core`         | pasa: 49 de 49                       | pasa: 49 de 49                   |                                                                                                                                                                                                          |
| `packages/source-control-forgejo`      | pasa: 51 de 51                       | pasa: 51 de 51                   |                                                                                                                                                                                                          |
| `packages/source-control-gitcafe`      | pasa: 116 de 116                     | pasa: 116 de 116                 |                                                                                                                                                                                                          |
| `packages/source-control-github`       | pasa: 328 de 328                     | pasa: 328 de 328                 |                                                                                                                                                                                                          |
| `packages/source-control-gitlab`       | pasa: 125 de 125                     | pasa: 125 de 125                 |                                                                                                                                                                                                          |
| `packages/ssh`                         | pasa: 21 de 21                       | pasa: 21 de 21                   |                                                                                                                                                                                                          |
| `packages/tailscale`                   | pasa: 7 de 7                         | pasa: 7 de 7                     |                                                                                                                                                                                                          |
| `scripts`                              | pasa: 203 de 203                     | pasa: 203 de 203                 |                                                                                                                                                                                                          |

No tienen script `test`: `apps/marketing`, `packages/provider-testing`, `packages/source-control-definitions` y `packages/source-control-testing`. Con ellos son 36 paquetes en el workspace y 32 con pruebas. En la medición de tiempos, con la separación en tres pasadas, los 32 pasaron, `apps/web` incluida.

## Lo que no pasa en verde de forma fiable aquí

- `pnpm test` como orden única. `vp run -r test` ordena por dependencias y detiene la ejecución en el primer fallo. `apps/server` depende de `apps/web` y es lo último, así que cualquier fallo anterior deja el servidor sin ejecutar y el resumen cuenta 31 tareas en lugar de 32. El CI de upstream no usa `pnpm test`: separa el resto de paquetes, `web` y `server` en trabajos distintos, y el servidor corre con `test:cached` en ocho fragmentos y verificación de caché (`vp run test:cached -- --shard N/8 --verify-hits 1 --report <archivo> apps/server`). `es:test` y la medición de tiempos adaptan en local esa separación en tres pasadas, sin fragmentos ni caché de pruebas.
- `infra/task-cache/src/runHook.test.ts` es intermitente cuando corre junto a otras suites. Falló en tres ejecuciones registradas: `pnpm test` antes y después de instalar los requisitos (`baseline/test.log`, `after/test.log`) y la primera pasada «resto» de la medición de tiempos (`timing/ci-rest.log`), que se cortó por ello. Pasó en las dos ejecuciones aisladas del paquete de la batería (`baseline/pkg-infra_task-cache.log`, `after/pkg-infra_task-cache.log`), en la repetición de «resto» (`timing/ci-rest2.log`) y en las repeticiones de `repeats/`: 6 de 6 con el paquete entero y 5 de 5 con el archivo solo, con carga media de un minuto entre 8,1 y 9,2. Afecta a la telemetría de la caché remota de upstream, que Earlyscript no usa. No se modificó la prueba.
- `apps/web` falla en algunas pruebas cuando corre junto a otras suites con el LXC cargado. En `timing/full1-test.log`, `timing/full2-test.log` y las corridas de `timing-aborted/` se observaron dos tipos de fallo:
  - Tiempos agotados: el límite de 15 s de la prueba en `src/localApi.test.ts`, `src/lib/runtime.test.ts`, `MessagesTimeline.browser.test.tsx` y `TelemetryExportSettings.browser.test.tsx`, y el de `locator.click` en `TelemetryExportSettings` y `AttachmentFilePreview` (`*.browser.test.tsx`).
  - Aserciones: un `vi.fn()` llamado más veces o con otros argumentos de lo esperado en `src/lib/runtime.test.ts`, `TelemetryExportSettings.browser.test.tsx` y `ThemeImportDialog.browser.test.tsx`.
- Con `web` sola, `apps/web` pasó en las dos pasadas de `es:test` (`timing/fast1-es:test.log`, `timing/fast2-es:test.log`) y en la medición de tiempos (`timing/ci-web.log`, 434 archivos). En la corrida «después» (`after/pkg-apps_web.log`) falló una prueba de `OpenInPicker.browser.test.tsx` por aserción, no por tiempo: esperaba que no se anunciara nada y recibió «Opened in VS Code». Al repetir el archivo solo pasó 3 de 3 (`repeats/web-OpenInPicker-{1,2,3}.log`). Hipótesis no comprobada: los fallos dependen de la carga de la máquina, porque desaparecen al ejecutar con menos suites a la vez; no se descartó un fallo de orden o de estado compartido en esas pruebas.
- Pruebas condicionadas: en Linux se omiten 4 de `apps/server` y 2 de `packages/shared`. En esos paquetes las condiciones `skipIf`/`runIf` dependen de la plataforma (Windows o macOS), del soporte de enlaces simbólicos o de la versión de undici. Las que dependen de la plataforma se verifican solo en ella: macOS en Gertrudis; Windows no está disponible en este entorno.

## Tiempos

Tiempos de pared en segundos, medidos con `date` alrededor de cada orden. Durante las mediciones otros tres agentes ejecutaban sus propias baterías en el mismo LXC de 8 núcleos: la carga media de un minuto osciló entre 1,4 y 34,6, casi siempre entre 6 y 17. Los tiempos están inflados y sirven para comparar órdenes entre sí, no como referencia absoluta. Registro completo en `~/earlyscript-data/build-scope/timing/`. Las órdenes de cada medición están en `~/earlyscript-data/build-scope/bin/`.

Las tres pasadas adaptan en local la separación del CI y se ejecutaron desde la raíz con `node_modules/.bin` en el `PATH` (`bin/timing-ci.sh`):

```sh
vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo' --filter '!@t3tools/web' test
vp run --filter @t3tools/web test
vp run --filter t3 test
```

| Orden                           | Corrida 1         | Corrida 2 | Resultado                                                                                   |
| ------------------------------- | ----------------- | --------- | ------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                | 2                 | 2         | Pasa. Usa la caché de `vp`; sin caché (`vp run -r --no-cache typecheck`) tardó 40.          |
| `pnpm lint`                     | 19                | 31        | Pasa.                                                                                       |
| `pnpm test`                     | 722               | 754       | 30 de 31 tareas: `web` agota tiempos con carga y `server` no llega a ejecutarse.            |
| `pnpm build`                    | 21                | 21        | Pasa (`web`, `marketing`, `server`, `desktop`).                                             |
| Tres pasadas: resto en paralelo | 137, cortada; 296 |           | La primera se cortó por `task-cache` (19 de 23 tareas iniciadas); la repetición pasó 30/30. |
| Tres pasadas: `web` sola        | 359               |           | Pasa, 434 archivos.                                                                         |
| Tres pasadas: `server` sola     | 1.355             |           | Pasa, 432 archivos.                                                                         |
| `es:typecheck`                  | 1                 | 2         | Pasa (misma orden y caché que `pnpm typecheck`).                                            |
| `es:lint`                       | 17                | 17        | Pasa.                                                                                       |
| `es:test`                       | 2.058             | 1.944     | Pasa: 11 paquetes en paralelo, después `web` y después `server`.                            |
| `es:build`                      | 20                | 20        | Pasa (`web`, `server`, `desktop`).                                                          |

La batería completa en verde, con las tres pasadas, suma unos 2.010 s de pruebas (296 + 359 + 1.355) más 2 de typecheck, 19 a 31 de lint y 21 de compilación. La rápida suma entre 1.960 y 2.080 s. La diferencia es pequeña porque `apps/server` ejecuta sus archivos de uno en uno (`fileParallelism: false`) y ocupa unos 23 minutos en las dos. Lo que `es:test` deja fuera son unos 4 minutos de pruebas que corren en paralelo. Para el ciclo de cada cambio sirven más `pnpm es:test:changed`, que envuelve `check:changed` de upstream y prueba solo lo afectado, o `vp test run <archivos>`; `es:test` sirve para cerrar una unidad de trabajo.

Una medición anterior, con `es:test` en una sola pasada, terminó en 481 s con 11 de 12 tareas: `web` falló con dos tiempos agotados y una aserción (`timing-aborted/fast1-es:test.log`) y el servidor no se ejecutó. Por eso `es:test` reparte las pasadas.
