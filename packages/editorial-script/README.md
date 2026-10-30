# Validador del guion

`@earlyscript/editorial-script` analiza Markdown sin depender de T3, de aplicaciones ni de servicios externos. No modifica el archivo.

## Formato

El guion contiene `# Hook`, uno o más bloques numerados desde 1 y `# Close`, en ese orden. `# Sources` es opcional y aparece al final. Los encabezados son de nivel 1, distinguen mayúsculas y no se repiten. Cada sección obligatoria contiene texto. Se aceptan `# Block 1 · Evidence`, `# Block 1: Evidence` y `# Block 1`. Los encabezados de niveles 2 a 6 se omiten y separan párrafos.

El frontmatter opcional empieza en la primera línea con `---` y termina con otra línea `---`. Solo admite pares simples `trend: valor`, `thread: valor`, `mode: valor` y `version: valor`. Todos se conservan como cadenas. Se eliminan comillas exteriores coincidentes. No se interpretan tipos, comentarios, listas, estructuras YAML ni escapes. Las claves desconocidas o duplicadas producen diagnósticos.

Una cita es `[itm_hn_50061234]`. Admite varias referencias separadas por comas, como `[itm_hn_50061234, itm_github_987]`. La forma corta `[hn:50061234]` se normaliza a `itm_hn_50061234`. La fuente empieza con una letra minúscula y admite letras minúsculas, números y guiones. El identificador admite letras, números, guiones y guiones bajos. Un corchete con tokens inválidos no es una cita; puede dejar una afirmación sin cita.

## Conteo mecánico

Cada oración del cuerpo cuenta como afirmación, salvo preguntas y oraciones de menos de cuatro palabras. Se omiten frontmatter, encabezados y todo el contenido de Sources. Los párrafos se separan por líneas vacías o encabezados. Los saltos de línea dentro de un párrafo no cortan oraciones.

Los puntos, signos de exclamación e interrogación cierran oraciones cuando les sigue espacio o fin de párrafo. Los decimales entre dígitos no las cortan. Una cita inmediatamente posterior al signo final pertenece a esa oración. El texto final sin puntuación también cuenta. Las palabras son secuencias Unicode de letras o números, con apóstrofes y guiones interiores. Las citas no suman palabras. Cualquier oración que contenga `?` se excluye, sin intentar distinguir preguntas retóricas de otras preguntas.

Una oración conserva sus citas explícitas. Si no tiene ninguna, hereda las citas de la última oración del párrafo, incluso si esa última oración se excluye del conteo. No se heredan citas de otro párrafo ni de Sources. `claimsMap` devuelve las referencias efectivas, sin duplicados, para cada afirmación y su posición inicial. Las posiciones empiezan en 1; las columnas usan unidades UTF-16.

Esto no es un analizador completo de Markdown ni un segmentador lingüístico. Abreviaturas, enlaces, listas y código pueden alterar el conteo. No se usan bloques de código en el formato del guion. El validador no juzga si una fuente respalda una afirmación, si esta es verificable o si está bien redactada. No mide el objetivo académico del 90 %: ese resultado exige inventario humano sobre la versión decidida.

## API y CLI

`parseScript(markdown)` devuelve `ScriptAst` con metadatos, secciones, párrafos, afirmaciones, citas y diagnósticos de análisis. `checkScript(markdown, { dossier? })` devuelve `ScriptCheckReport`, con `structure`, `diagnostics`, `counts`, `uncitedClaims`, `unknownCitations` y `claimsMap`.

El expediente opcional debe ser un objeto con `evidence` como arreglo de objetos que contengan `item_id` canónicos. Se admiten sus demás campos. Un expediente mal formado lanza `TypeError`. Un expediente vacío marca todas las citas como desconocidas. Las citas de Sources también se cotejan; la existencia en el expediente no demuestra respaldo semántico. Una cita desconocida sigue contando como cita presente y aparece por separado como error.

Desde la raíz del monorepo. pnpm ejecuta la CLI en el directorio del paquete; las rutas relativas parten de ese directorio:

```sh
pnpm --filter @earlyscript/editorial-script check fixtures/valid.md
pnpm --filter @earlyscript/editorial-script check guion.md --dossier expediente.json --json
```

La CLI devuelve 0 si no hay diagnósticos, 1 si el guion contiene problemas y 2 por argumentos, archivos o expediente inválidos. Los diagnósticos son en inglés con línea y columna. `--json` produce el informe en stdout; los errores de entrada van a stderr.

## Ejemplo comprobado

El ejemplo usa referencias sintéticas y coincide con `fixtures/valid.md`. Las pruebas extraen este bloque del README y comprueban su resultado.

```markdown
# Hook

Developers now discuss local models [itm_hn_50061234].

# Block 1 · Evidence

The repository contains reproducible examples. The examples include installation commands [itm_github_987].

# Close

Review the evidence before choosing [itm_hn_50061234, itm_github_987].

# Sources

[itm_hn_50061234]
[itm_github_987]
```

Salida del validador:

```text
Structure: OK
Claims: 4, cited: 4, uncited: 0
Unknown citations: 0
```
