# Divergencia respecto de upstream

Lista de revisión de cada fusión con `upstream` (T3 Code, `github.com/pingdotgg/t3code`). Cada archivo de upstream que Earlyscript modifica aparece aquí con sus líneas y su motivo. Otras ramas añaden sus propias secciones; se unen al fusionar.

Base de upstream: `aa11ef6783` (30 de octubre de 2026).

## Batería rápida (rama `es/build-scope`, 30 de octubre de 2026)

### Archivos de upstream modificados

| Archivo        | Líneas | Motivo                                                                                                                                                                      |
| -------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` | 56-61  | Coma tras `sync:repos` y cinco scripts nuevos al final de `scripts`: `es:check-scope`, `es:typecheck`, `es:lint`, `es:test` y `es:build`. Ningún script de upstream cambia. |

### Archivos propios

| Archivo                             | Contenido                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `scripts/earlyscript/packages.json` | Clasificación de cada paquete del workspace para la batería rápida, con su motivo.       |
| `scripts/earlyscript/scope.ts`      | Comprobación de alcance y ejecución filtrada de `test` y `build`.                        |
| `scripts/earlyscript/scope.test.ts` | Pruebas de la comprobación. Corren con las de `@t3tools/scripts` en la batería completa. |
| `docs/dev-environment-linux.md`     | Requisitos del LXC, resultados por paquete y tiempos de ambas baterías.                  |
| `docs/upstream-divergence.md`       | Este registro.                                                                           |

`scripts/earlyscript/` está dentro del paquete de upstream `@t3tools/scripts`, cuyo `tsconfig.json` incluye `**/*.ts` y cuya prueba usa `--dir .`. Por eso el typecheck y las pruebas de la batería completa cubren estos archivos sin tocar configuración de upstream. Al fusionar, comprobar que siguen pasando `pnpm --filter @t3tools/scripts typecheck` y `pnpm run knip:check`.

Al fusionar con upstream, ejecutar `pnpm run es:check-scope`: si upstream añadió o renombró un paquete, la comprobación falla hasta clasificarlo en `scripts/earlyscript/packages.json`.
