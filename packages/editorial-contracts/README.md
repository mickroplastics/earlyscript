# @earlyscript/editorial-contracts

Esquemas de Effect de los primitivos editoriales de Earlyscript, sin dependencia de T3 ni de `apps/*`.

| Subruta         | Contenido                                                                          |
| --------------- | ---------------------------------------------------------------------------------- |
| `./source`      | Fuente, cobertura por día (`corpus/1`), huecos de datos                            |
| `./item`        | Ítem (línea de `corpus/1`) y Corte (medianoche UTC)                                |
| `./profile`     | Perfil del canal (`profile/1`)                                                     |
| `./dossier`     | Tendencia y Expediente (`earlyscript.dossier/1`) con las dos posiciones de ranking |
| `./run`         | Configuración del motor y Corrida (`earlyscript.run/1`)                            |
| `./decision`    | Hilo de video, Decisión y Resultado: formas mínimas, todavía sin productor         |
| `./earlywindow` | Lectura de `dossier/1` y del manifiesto `corpus/1` de Earlywindow                  |

`fromEarlywindowRun` convierte todos los expedientes de una corrida de Earlywindow. Un `dossier/1` no guarda `items_7d` ni la posición por línea base; se reconstruyen desde la curva con la regla del backtest de Earlywindow (`items_7d` desc, id de señal asc). `items_total`, `nearest_include`, `similarity`, plataforma y arquitectura quedan en `null`.
