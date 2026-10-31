# Earlyscript en macOS (uso diario)

Cómo compilar, instalar y abrir Earlyscript como app nativa en un Mac con Apple Silicon, con los datos en local. Probado en Gertrudis (M4, macOS 27) el 31 de octubre de 2026.

## Compilar

```sh
mise exec node@26.12.1 pnpm@12.14.0 -- pnpm es:build
env -u T3CODE_HOME CSC_IDENTITY_AUTO_DISCOVERY=false T3CODE_DESKTOP_SIGNED=false \
  mise exec node@26.12.1 pnpm@12.14.0 -- pnpm dist:desktop:artifact \
  --platform mac --target dmg --arch arm64 --skip-build --output-dir ~/earlyscript-data/macos/artifacts
```

Salen `Earlyscript-<versión>-arm64.dmg` y `.zip`. No llevan firma Developer ID ni notarización, solo la firma ad hoc del enlazador.

## Instalar y abrir

Copiar `Earlyscript (Beta).app` del DMG a `~/Applications` (o `/Applications`).

Una app sin firma que llega descargada o copiada desde otra máquina lleva el atributo de cuarentena y Gatekeeper la bloquea. La primera vez: clic derecho sobre la app › Abrir › Abrir. O, desde la terminal:

```sh
xattr -dr com.apple.quarantine ~/Applications/"Earlyscript (Beta).app"
```

Una compilación hecha en el mismo Mac no lleva cuarentena.

Abrir cada día (Dock, Spotlight o esta línea):

```sh
env -u T3CODE_HOME open -a ~/Applications/"Earlyscript (Beta).app"
```

`env -u T3CODE_HOME` importa solo si se lanza desde una terminal de T3 Code: esas terminales exportan `T3CODE_HOME=~/.t3`. `open` pasa el entorno a la app, y la app trataría de usar el directorio del T3 Code real. El guardia de upstream lo detecta, muestra «This T3 home is unavailable» y no escribe nada. Desde el Dock o Finder no pasa.

## Dónde quedan los datos

| Qué                                                                                 | Ruta                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Estado de la app (hilos, `statev2.sqlite`, `editorial.sqlite`, secretos, registros) | `~/.earlyscript/userdata/`                                      |
| Perfil de Electron (caché, almacenamiento local)                                    | `~/Library/Application Support/earlyscript/`                    |
| CLI `earlyscript` instalado por la app                                              | `~/.earlyscript/bin/earlyscript`                                |
| Servidor embebido                                                                   | `127.0.0.1:4773`                                                |
| Corpus de fuentes (Ajustes › Editorial › Fuentes)                                   | `~/earlyscript-data/live/` (`EARLYSCRIPT_EDITORIAL_CORPUS_DIR`) |
| Corridas del motor (Tendencias)                                                     | `~/earlyscript-data/runs/` (`EARLYSCRIPT_EDITORIAL_RUNS_DIR`)   |
| Modelo de embeddings (Qwen3 0,6B ONNX q8, unos 600 MB)                              | `~/earlyscript-data/models/<revisión>/`                         |
| Caché de embeddings                                                                 | `~/earlyscript-data/embeddings/embeddings.sqlite`               |

T3 Code real usa `~/.t3` y el puerto 3773 (en Gertrudis corre como servicio `t3`). Las dos apps pueden estar abiertas a la vez sin compartir estado.

## Motor

El `.app` no incluye el motor (`packages/trend-engine`) ni `onnxruntime-node`. Se ejecuta desde el checkout, con el `node` del sistema (26.12.1 por mise) o con el de Electron (`ELECTRON_RUN_AS_NODE=1`, Node 24.22.1 en Electron 44). Con los dos, `engine check` y `engine check --rerun` dan el mismo `logical_hash`.

```sh
cd ~/earlyscript/packages/trend-engine
node src/cli.ts collect --corpus ~/earlyscript-data/live --sources hn,github --from 2026-10-03 --to 2026-10-31
node src/cli.ts run --corpus ~/earlyscript-data/live --cutoff 2026-10-31T00:00:00Z \
  --profile ~/earlyscript-data/profiles/singularidev.v1.json --out ~/earlyscript-data/runs --workers 4
node src/cli.ts check --run ~/earlyscript-data/runs/<run_id>
```

En un M4 con la caché vacía, 28 días de HN y GitHub (unos 26 000 textos) tardan unos 15 minutos con 4 procesos y como mucho 2,2 GB de RSS por proceso. Con la caché llena, la reejecución tarda unos 20 segundos. La primera corrida descarga el modelo desde Hugging Face. Cada proceso lo descarga por su cuenta, así que conviene una primera corrida con `--workers 1` o descargar el modelo antes.

## Títulos con el asistente

«Redactar con el asistente» usa el modelo de Ajustes › Threads › Text generation model. El servidor embebido lanza el CLI del proveedor que encuentra en el PATH del shell de login (por ejemplo, `~/.local/bin/claude`). Para gastar poco, elegir Claude Haiku o GPT Luna.

## Abrir al iniciar sesión (opcional)

Este agente de `launchd` solo abre la app al iniciar sesión y la reabre si se cierra por un fallo. Si se sale con ⌘Q, no la reabre. No ejecuta el motor. No está instalado. Para usarlo, guárdalo como `~/Library/LaunchAgents/cc.biste.earlyscript.open.plist` y ejecuta `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/cc.biste.earlyscript.open.plist`. Para quitarlo, ejecuta `launchctl bootout gui/$(id -u)/cc.biste.earlyscript.open` y borra el archivo.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cc.biste.earlyscript.open</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/miguel/Applications/Earlyscript (Beta).app/Contents/MacOS/Earlyscript (Beta)</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
```

Añadir la app en Ajustes del Sistema › General › Ítems de inicio hace lo mismo, sin reabrirla tras un fallo.
