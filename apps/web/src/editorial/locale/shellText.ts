import { snoozePresetLabel } from "../editorial.logic";
import type { LocaleTable } from "./scopedLocale";

/**
 * Spanish for the upstream shell seen daily: sidebar, thread area and the settings in use.
 * Names (models, providers, projects, branches, themes, paths, keys) are never keys, and no
 * value is a key of any table (`shellLocale.test.ts`), so a rewrite never triggers another.
 */

/** Words shared by menus and dialogs in every zone. */
const SHELL_COMMON_TEXT: Readonly<Record<string, string>> = {
  Cancel: "Cancelar",
  Confirm: "Confirmar",
  Delete: "Borrar",
  Close: "Cerrar",
  Copy: "Copiar",
  Search: "Buscar",
  "Search...": "Buscar…",
  Settings: "Ajustes",
  Usage: "Uso",
  Enabled: "Activada",
  Disabled: "Desactivada",
  Default: "Predeterminado",
  None: "Ninguno",
  Off: "Desactivado",
  Navigate: "Navegar",
  Select: "Elegir",
  "Context menu": "Menú contextual",
  "Command palette": "Paleta de comandos",
  Notifications: "Notificaciones",
  "Just now": "Ahora mismo",
};

/** Sidebar: header, rows, sections, context and snooze menus, project filter and dialogs. */
/** The thread actions menu: the sidebar row's context menu and the thread header's menu. */
const THREAD_ACTION_TEXT: Readonly<Record<string, string>> = {
  "Settle thread": "Marcar como resuelto",
  "Un-settle thread": "Quitar de resueltos",
  "Unpin thread": "Desfijar el hilo",
  "Pin thread": "Fijar el hilo",
  "Wake thread": "Reactivar el hilo",
  "Wake thread now": "Reactivar ahora",
  Snooze: "Posponer",
  "Custom…": "Personalizado…",
  "Rename thread": "Renombrar el hilo",
  "Regenerate title": "Regenerar el título",
  "Regenerating…": "Regenerando…",
  "Mark unread": "Marcar como no leído",
  "Share with guest": "Compartir con un invitado",
  "Show all projects": "Mostrar todos los proyectos",
  "Turn into project": "Convertir en proyecto",
  "Auto-settle behavior": "Marcar como resuelto automáticamente",
  Path: "Ruta",
  Branch: "Rama",
  Thread: "Hilo",
  "Thread ID": "ID del hilo",
  "Project settings": "Ajustes del proyecto",
  "Archive thread": "Archivar el hilo",
  "Find in thread": "Buscar en el hilo",
  Enabled: "Activada",
  Disabled: "Desactivada",
};

const SIDEBAR_TEXT: Readonly<Record<string, string>> = {
  ...THREAD_ACTION_TEXT,
  "Drag to resize sidebar": "Arrastra para cambiar el ancho",
  Threads: "Hilos",
  "Toggle main sidebar": "Mostrar u ocultar la barra lateral",
  "Toggle Sidebar": "Mostrar u ocultar la barra lateral",
  "Resize Sidebar": "Cambiar el ancho de la barra lateral",
  "Go to threads": "Ir a los hilos",
  "Search threads": "Buscar hilos",
  "Clear thread search": "Borrar la búsqueda",
  "Thread search results": "Resultados de la búsqueda",
  "Filter threads by project": "Filtrar hilos por proyecto",
  "Add project": "Agregar proyecto",
  "New thread": "Nuevo hilo",
  "Thread title": "Título del hilo",
  "Snooze thread": "Posponer el hilo",
  Settle: "Resolver",
  Settled: "Resueltos",
  Snoozed: "Pospuestos",
  Pinned: "Fijados",
  Working: "En curso",
  Active: "Activos",
  Skipped: "Omitidos",
  Waiting: "Esperando",
  Approval: "Aprobación",
  Input: "Respuesta",
  Request: "Solicitud",
  Limited: "Sin cuota",
  Failed: "Falló",
  Woke: "Reactivado",
  Done: "Listo",
  "Unsent draft": "Borrador sin enviar",
  "Discard draft": "Descartar el borrador",
  "Copy path": "Copiar la ruta",
  "All projects": "Todos los proyectos",
  "Search projects": "Buscar proyectos",
  "Search projects...": "Buscar proyectos…",
  "No projects yet": "Aún no hay proyectos",
  "No matching projects.": "Ningún proyecto coincide.",
  "This permanently clears conversation history for this thread.":
    "Se borra para siempre el historial de conversación de este hilo.",
  "Path copied": "Ruta copiada",
  "Branch copied": "Rama copiada",
  "Thread ID copied": "ID del hilo copiado",
  "Path unavailable": "Ruta no disponible",
  "This thread does not have a workspace path to copy.":
    "Este hilo no tiene una ruta de trabajo que copiar.",
  "Thread title cannot be empty": "El título del hilo no puede quedar vacío",
  "Project created": "Proyecto creado",
  "Failed to copy path": "No se copió la ruta",
  "Failed to copy branch": "No se copió la rama",
  "Failed to copy thread ID": "No se copió el ID del hilo",
  "Failed to rename thread": "No se renombró el hilo",
  "Failed to settle thread": "No se marcó el hilo como resuelto",
  "Failed to un-settle thread": "No se quitó el hilo de resueltos",
  "Failed to wake thread": "No se reactivó el hilo",
  "Failed to pin thread": "No se fijó el hilo",
  "Failed to unpin thread": "No se desfijó el hilo",
  "Failed to snooze thread": "No se pospuso el hilo",
  "Failed to delete thread": "No se borró el hilo",
  "Failed to delete threads": "No se borraron los hilos",
  "Failed to regenerate thread title": "No se regeneró el título",
  "Failed to regenerate thread titles": "No se regeneraron los títulos",
  "Failed to update auto-settle": "No se cambió la resolución automática",
  "Thread action unavailable": "Acción no disponible",
  "Could not create thread": "No se pudo crear el hilo",
  "Thread deleted, but navigation failed": "El hilo se borró, pero no se pudo navegar",
  // Add-project palette frame. Its items keep upstream's English: their titles share the
  // element (`dir`) that shows thread titles, which is user text.
  Sources: "Orígenes",
};

const SIDEBAR_PATTERNS: LocaleTable["patterns"] = [
  [/^New thread in (.+)$/, "Nuevo hilo en $1"],
  [/^New thread, (.+)$/, "Nuevo hilo, $1"],
  [/^New thread on (.+)$/, "Nuevo hilo en la rama $1"],
  [/^Filter by (.+)$/, "Filtrar por $1"],
  [/^Filter threads by project: (.+)$/, "Filtrar hilos por proyecto: $1"],
  [/^Project settings for (.+)$/, "Ajustes del proyecto $1"],
  [/^Delete thread "(.+)"\?$/, "¿Borrar el hilo «$1»?"],
  [/^Settle \((\d+)\)$/, "Resolver ($1)"],
  [/^Snooze \((\d+)\)$/, "Posponer ($1)"],
  [/^Mark unread \((\d+)\)$/, "Marcar como no leídos ($1)"],
  [/^Delete \((\d+)\)$/, "Borrar ($1)"],
];

/** Snooze presets, `Label (when)` in the row menu, through the fork's own table. */
export function snoozeMenuLabel(value: string): string {
  const withWhen = /^(.+) \(([^()]+)\)$/.exec(value);
  if (withWhen !== null) {
    const label = snoozePresetLabel(withWhen[1] ?? "");
    return label === withWhen[1] ? value : `${label} (${withWhen[2]})`;
  }
  return snoozePresetLabel(value);
}

/** Thread area: header, empty states, composer chrome and its menus, panels. */
const THREAD_TEXT: Readonly<Record<string, string>> = {
  ...THREAD_ACTION_TEXT,
  // «¿Qué construimos en <proyecto>?»: upstream writes « in» as its own node.
  in: "en",
  "Send a message to start the conversation.": "Escribe un mensaje para empezar la conversación.",
  "Ask anything. @ files, $ skills, / commands":
    "Pregunta lo que quieras. @ archivos, $ habilidades, / órdenes",
  "Ask anything...": "Pregunta lo que quieras…",
  "Enable a provider in Settings": "Activa un proveedor en Ajustes",
  "Enable a provider in Settings to send a message":
    "Activa un proveedor en Ajustes para enviar un mensaje",
  "Choose a project above to start a thread": "Elige un proyecto arriba para empezar un hilo",
  "Choose an option above": "Elige una opción arriba",
  "Send feedback to decline this request": "Escribe por qué rechazas esta solicitud",
  "Send a message to decline and redirect the agent":
    "Escribe un mensaje para rechazar y reorientar al agente",
  "Type your own answer, or leave this blank to use the selected option":
    "Escribe tu respuesta o déjalo en blanco para usar la opción elegida",
  "Add feedback to refine the plan, or leave this blank to implement it":
    "Comenta el plan para afinarlo o déjalo en blanco para ejecutarlo",
  "What should we build in": "¿Qué construimos en",
  "What should we build": "¿Qué construimos",
  "New thread": "Nuevo hilo",
  "Thread breadcrumb": "Ruta del hilo",
  Conversation: "Conversación",
  "Message input": "Mensaje",
  "Attach files": "Adjuntar archivos",
  "Markdown source": "Markdown sin formato",
  "Submit message": "Enviar el mensaje",
  "Queue message": "Poner el mensaje en cola",
  "Steer message": "Redirigir con el mensaje",
  "Environment disconnected": "Entorno desconectado",
  "Preparing worktree": "Preparando el worktree",
  "New worktree": "Worktree nuevo",
  "This device is offline": "Este dispositivo no tiene conexión",
  "Could not reconnect environment": "No se pudo reconectar el entorno",
  Retry: "Reintentar",
  "More composer controls": "Más controles",
  "Maximize panel": "Maximizar el panel",
  "Toggle thread details panel": "Mostrar u ocultar los detalles del hilo",
  "Toggle right panel": "Mostrar u ocultar el panel derecho",
  "Thread details": "Detalles del hilo",
  Workspace: "Espacio de trabajo",
  "Workspace panel": "Panel de trabajo",
  "Open in editor": "Abrir en el editor",
  "Choose editor": "Elegir editor",
  "Add project script": "Agregar script del proyecto",
  "Version Control": "Control de versiones",
  "Git actions": "Acciones de Git",
  "Git action options": "Opciones de Git",
  Changes: "Cambios",
  "Current checkout": "Checkout actual",
  "Open a surface": "Abrir una vista",
  "Add panel surface": "Agregar una vista al panel",
  "Open browser in a profile": "Abrir el navegador con un perfil",
  Browser: "Navegador",
  Files: "Archivos",
  Device: "Dispositivo",
  // Model picker and traits menu. Model and provider names stay as they are.
  Providers: "Proveedores",
  Favorites: "Favoritos",
  "Legacy models": "Modelos anteriores",
  "Search models...": "Buscar modelos…",
  "Add to favorites": "Agregar a favoritos",
  Reasoning: "Razonamiento",
  Low: "Bajo",
  Medium: "Medio",
  High: "Alto",
  "Extra High": "Muy alto",
  "Service Tier": "Nivel de servicio",
  Standard: "Estándar",
  Fast: "Rápido",
  "2x speed, increased usage": "El doble de rápido, con más consumo",
  Permissions: "Permisos",
  Supervised: "Supervisado",
  "Auto-accept edits": "Aceptar ediciones",
  "Full access": "Acceso total",
  "Ask before commands and file changes.": "Pregunta antes de órdenes y cambios en archivos.",
  "Auto-approve edits, ask before other actions.":
    "Aprueba las ediciones y pregunta antes de lo demás.",
  "Supported providers approve routine actions; others still ask.":
    "Los proveedores compatibles aprueban lo rutinario; los demás siguen preguntando.",
  "Allow commands and edits without prompts.": "Permite órdenes y ediciones sin preguntar.",
  // Timeline rows: the author heading, the turn's fold and the message actions.
  You: "Tú",
  Worked: "Trabajó",
  "You stopped this response": "Detuviste esta respuesta",
  "Copy message": "Copiar el mensaje",
  "Copy prompt link": "Copiar el enlace a la petición",
  "Fork from this response": "Bifurcar desde esta respuesta",
  // The thread's spoken status (`threadActivityAnnouncement.ts`).
  Done: "Listo",
  "Needs approval": "Necesita aprobación",
  "Needs your input": "Necesita tu respuesta",
  Failed: "Falló",
  Stopped: "Detenido",
  // The file surface in the right panel, where the script is read and edited.
  Open: "Abrir",
  "Open file in preferred editor": "Abrir el archivo en el editor preferido",
  "Show rendered markdown": "Mostrar el markdown renderizado",
  "Show markdown source": "Mostrar el texto del markdown",
  "Enable word wrap": "Ajustar las líneas",
  "Disable word wrap": "No ajustar las líneas",
  "Show file explorer": "Mostrar el explorador de archivos",
  "Hide file explorer": "Ocultar el explorador de archivos",
  "Refresh workspace files": "Actualizar los archivos",
  "Collapse all folders": "Plegar todas las carpetas",
  "Search files": "Buscar archivos",
};

const THREAD_PATTERNS: LocaleTable["patterns"] = [
  [/^Filter by (.+)$/, "Filtrar por $1"],
  [/^New thread on (.+)$/, "Nuevo hilo en la rama $1"],
  [/^Thread actions for (.+)$/, "Acciones del hilo $1"],
  [/^New thread in (.+)$/, "Nuevo hilo en $1"],
  [
    /^Run context: (.+), (.+)$/,
    (match, translate) => `Contexto de ejecución: ${match[1]}, ${translate(match[2] ?? "")}`,
  ],
  [/^Run context: (.+)$/, "Contexto de ejecución: $1"],
  // Connection banner above the composer: the machine's name is a value.
  [/^(.+) is reconnecting$/, "$1 se está reconectando"],
  [/^(.+) is offline$/, "$1 está sin conexión"],
  [/^T3 Code on (.+) did not answer$/, "El servidor en $1 no respondió"],
  [/^T3 Code on (.+) did not accept this device$/, "El servidor en $1 no aceptó este dispositivo"],
  [/^(.+) did not answer in time$/, "$1 no respondió a tiempo"],
  [
    /^Effort: (.+?) · Permissions: (.+?)((?: · .+)?)$/,
    (match, translate) =>
      `Esfuerzo: ${translate(match[1] ?? "")} · Permisos: ${translate(match[2] ?? "")}${match[3] ?? ""}`,
  ],
  [/^Permissions: (.+)$/, (match, translate) => `Permisos: ${translate(match[1] ?? "")}`],
  // The turn's fold; the duration is upstream's compact format («35s», «2m 5s»).
  [/^Worked for (.+)$/, "Trabajó durante $1"],
  [/^Working for (.+)$/, "Trabajando desde hace $1"],
  [/^You stopped after (.+)$/, "Lo detuviste tras $1"],
  // File surface: the file or folder's name is a value.
  [/^Close (.+)$/, "Cerrar $1"],
  [/^Browse (.+)$/, "Explorar $1"],
];

/** Settings: navigation and the General, Appearance, Providers and Chat sections. */
const SETTINGS_TEXT: Readonly<Record<string, string>> = {
  "Settings sections": "Secciones de ajustes",
  "Search settings": "Buscar en ajustes",
  "Settings content": "Contenido de ajustes",
  "Settings breadcrumb": "Ruta de ajustes",
  Appearance: "Apariencia",
  "Diffs & pull requests": "Diffs y pull requests",
  Keybindings: "Atajos de teclado",
  Agents: "Agentes",
  Providers: "Proveedores",
  Threads: "Hilos",
  Devices: "Dispositivos",
  "Scheduled tasks": "Tareas programadas",
  Code: "Código",
  Projects: "Proyectos",
  "Source control": "Control de versiones",
  Maintenance: "Mantenimiento",
  Browser: "Navegador",
  About: "Acerca de",
  Archive: "Archivo",
  "Restore device defaults": "Restaurar los valores del dispositivo",
  // General.
  "Thread notifications": "Avisos de hilos",
  "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while Earlyscript is open.":
    "Avisos del sistema cuando un hilo termina, falla o necesita una respuesta o una aprobación. En este dispositivo, mientras Earlyscript está abierto.",
  "In-app notifications": "Avisos dentro de la app",
  "Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.":
    "Muestra un aviso cuando otro hilo termina, falla o necesita una respuesta o una aprobación mientras la app está en primer plano.",
  Sidebar: "Barra lateral",
  "Project grouping": "Agrupar proyectos",
  "Combine matching repositories across environments.":
    "Une los repositorios iguales de distintos entornos.",
  "Project order": "Orden de los proyectos",
  "Order of projects in the sidebar project picker and command palette.":
    "Orden de los proyectos en el selector de la barra lateral y en la paleta de comandos.",
  "Last user message": "Último mensaje del usuario",
  "Working section": "Sección «En curso»",
  "Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you. The boring sidebar in Labs has no Working section.":
    "Agrupa los hilos en curso y en observación en una sección «En curso». Vuelven arriba cuando te necesitan. La barra lateral sencilla de Labs no tiene esta sección.",
  Confirmations: "Confirmaciones",
  "Unpin confirmation": "Confirmar al desfijar",
  "Ask before unpinning a thread from the pinned section.":
    "Pregunta antes de quitar un hilo de los fijados.",
  "Archive confirmation": "Confirmar al archivar",
  "Require a second click on the inline archive action before a thread is archived.":
    "Pide un segundo clic en «Archivar» antes de archivar un hilo.",
  "Delete confirmation": "Confirmar al borrar",
  "Ask before deleting a thread and its chat history.":
    "Pregunta antes de borrar un hilo y su historial.",
  Display: "Presentación",
  "Time format": "Formato de hora",
  "Timestamp format": "Formato de hora",
  "System default follows your browser or OS clock preference.":
    "«Del sistema» sigue la preferencia de reloj del navegador o del sistema operativo.",
  "System default": "Del sistema",
  "Confirm thread unpinning": "Confirmar al desfijar un hilo",
  "Confirm thread archiving": "Confirmar al archivar un hilo",
  "Confirm thread deletion": "Confirmar al borrar un hilo",
  // Appearance.
  "Colors & themes": "Colores y temas",
  "Color scheme": "Esquema de color",
  "Appearance mode": "Modo de apariencia",
  System: "Sistema",
  Light: "Claro",
  Dark: "Oscuro",
  "Follow the system appearance": "Seguir la apariencia del sistema",
  "Use light mode": "Usar el modo claro",
  "Use dark mode": "Usar el modo oscuro",
  Themes: "Temas",
  "Create theme": "Crear tema",
  "Add theme": "Agregar tema",
  Interface: "Interfaz",
  Contrast: "Contraste",
  "Adjust the contrast of colors and borders across the interface.":
    "Ajusta el contraste de colores y bordes en toda la interfaz.",
  "Glass opacity": "Opacidad del cristal",
  "Higher values make menus, dialogs, and the composer more solid.":
    "Con valores más altos, menús, diálogos y el editor de mensajes se ven más sólidos.",
  "Chat width": "Ancho del chat",
  "Set how wide messages and the composer can grow on large screens.":
    "Cuánto pueden ensancharse los mensajes y el editor en pantallas grandes.",
  Comfortable: "Cómodo",
  "Thread details": "Detalles del hilo",
  "Choose what the thread details card shows. You can also right-click the card.":
    "Elige qué muestra la tarjeta de detalles del hilo. También puedes hacer clic derecho en la tarjeta.",
  "Effort display": "Cómo se muestra el esfuerzo",
  "Show reasoning effort in the composer as its name, such as High, or as bars.":
    "Muestra el esfuerzo de razonamiento en el editor con su nombre (por ejemplo, Alto) o con barras.",
  Word: "Palabra",
  "Render math": "Mostrar fórmulas",
  "Typeset LaTeX math, such as $x^2$ or \\[x^2\\], in messages and Markdown previews. The composer keeps TeX source editable.":
    "Compone las fórmulas LaTeX, como $x^2$ o \\[x^2\\], en mensajes y vistas previas de Markdown. El editor conserva el código TeX editable.",
  Advanced: "Avanzado",
  Typography: "Tipografía",
  "Interface font": "Fuente de la interfaz",
  "Everything outside code blocks and the terminal.":
    "Todo lo que no es bloque de código ni terminal.",
  "Interface font family": "Familia de la fuente de la interfaz",
  "Interface font size": "Tamaño de la fuente de la interfaz",
  "Prompt font preview": "Vista previa de la fuente del mensaje",
  "Monospace font": "Fuente monoespaciada",
  "Code blocks, diffs, file previews, and the terminal.":
    "Bloques de código, diffs, vistas previas de archivos y la terminal.",
  "Monospace font family": "Familia de la fuente monoespaciada",
  "Code font size": "Tamaño de la fuente de código",
  "Terminal font preview": "Vista previa de la fuente de la terminal",
  "Word wrap": "Ajuste de línea",
  "Wrap long lines in code blocks, diffs, and file previews by default.":
    "Ajusta por defecto las líneas largas en bloques de código, diffs y vistas previas.",
  "Terminal input": "Entrada de la terminal",
  "Terminal scrollback": "Historial de la terminal",
  "Wrap code, diffs, and file previews by default":
    "Ajustar por defecto código, diffs y vistas previas",
  // Providers.
  "Applying settings for": "Se aplica a",
  "Refresh provider status": "Actualizar el estado de los proveedores",
  Checked: "Comprobado:",
  ago: "atrás",
  "Checked unavailable": "Sin comprobación",
  Available: "Disponible",
  "Add provider": "Agregar proveedor",
  Status: "Estado",
  "Authenticated as": "Sesión iniciada como",
  "Toggle account email visibility": "Mostrar u ocultar el correo de la cuenta",
  "Display name": "Nombre visible",
  "All projects": "Todos los proyectos",
  Reasoning: "Razonamiento",
  "Path to the Codex binary used by this instance.":
    "Ruta del binario de Codex que usa esta instancia.",
  "Custom Codex home and config directory.": "Directorio propio de Codex y de su configuración.",
  "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.":
    "Home de Codex propio de la cuenta. Separa auth.json y comparte el estado de CODEX_HOME.",
  "Additional CLI arguments passed to codex app-server on session start.":
    "Argumentos de CLI adicionales para codex app-server al iniciar la sesión.",
  "When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this.":
    "Cuándo compactar un hilo de Claude inactivo de más de 200.000 tokens: al volver, justo antes de que caduque su caché de prompt o nunca. Cada proveedor de Claude puede cambiarlo.",
  Runtime: "Ejecución",
  "Binary path": "Ruta del binario",
  "Shadow home path": "Directorio personal de la cuenta",
  "CODEX_HOME path": "Ruta de CODEX_HOME",
  "Shared Codex config, sessions, and state.":
    "Configuración, sesiones y estado compartidos de Codex.",
  "Launch arguments": "Argumentos de arranque",
  Environment: "Entorno",
  Variables: "Variables de entorno",
  "API keys, base URLs, and other per-instance CLI settings.":
    "Claves de API, URL base y otros ajustes de la CLI de esta instancia.",
  "Add variable": "Agregar variable",
  Models: "Modelos",
  "Model preferences and custom models are saved on the selected environment and shared across connected devices.":
    "Las preferencias de modelos y los modelos propios se guardan en el entorno elegido y se comparten con los dispositivos conectados.",
  "Disable all": "Desactivar todos",
  "Add custom model": "Agregar modelo propio",
  "Filter models": "Filtrar modelos",
  "Usage providers": "Proveedores de uso",
  "Add hub": "Agregar hub",
  "No hubs configured.": "No hay hubs configurados.",
  "Health check interval": "Intervalo de comprobación",
  "Refresh provider status, versions, and models in the background. Set to 0 to disable.":
    "Actualiza en segundo plano el estado, las versiones y los modelos de los proveedores. 0 lo desactiva.",
  seconds: "segundos",
  "Compact idle threads": "Compactar hilos inactivos",
  "When you return": "Al volver",
  "Background policy details": "Detalle de la política en segundo plano",
  "Decrease provider health check interval": "Reducir el intervalo de comprobación",
  "Provider health check interval in seconds": "Intervalo de comprobación en segundos",
  "Increase provider health check interval": "Aumentar el intervalo de comprobación",
  "Set on the environment. Show where this value comes from":
    "Definido en el entorno. Ver de dónde viene este valor",
  "Built-in default. Show where this value comes from":
    "Valor de fábrica. Ver de dónde viene este valor",
  // Chat.
  Composer: "Editor de mensajes",
  "Rich text composer": "Editor con formato",
  "Show formatted Markdown as you type.": "Muestra el Markdown con formato mientras escribes.",
  "Send shortcut": "Atajo de envío",
  "Choose when Enter sends a prompt or inserts a new line":
    "Elige cuándo Enter envía el mensaje o agrega una línea",
  "Follow-ups": "Mensajes de seguimiento",
  "Follow-up behavior": "Qué hacer con un mensaje de seguimiento",
  "Queue follow-ups while the agent runs or steer the current run. Press Ctrl + Enter to do the opposite for one message.":
    "Pon en cola los mensajes mientras el agente trabaja o redirige la ejecución en curso. Ctrl + Enter hace lo contrario para un mensaje.",
  Steer: "Redirigir",
};

const SETTINGS_PATTERNS: LocaleTable["patterns"] = [
  [/^Use (.+) light mode$/, "Usar $1 en modo claro"],
  [/^Use (.+) dark mode$/, "Usar $1 en modo oscuro"],
  [/^Use (.+) theme$/, "Usar el tema $1"],
  [/^Duplicate (.+)$/, "Duplicar $1"],
  [/^Thread details: (\d+) of (\d+) on$/, "Detalles del hilo: $1 de $2 activos"],
  [/^Project scope: All projects$/, "Proyectos: todos"],
  [/^Project scope: (.+)$/, "Proyecto: $1"],
  [/^Environment scope: All environments$/, "Entornos: todos"],
  [/^Environment scope: (.+)$/, "Entorno: $1"],
  // Provider names only: every word capitalized or in parentheses («Replay (dev)»).
  [/^Select ([A-Z0-9][^ ]*(?: (?:[A-Z0-9(][^ ]*))*)$/, "Elegir $1"],
  [/^Enable ([A-Z0-9][^ ]*(?: (?:[A-Z0-9(][^ ]*))*)$/, "Activar $1"],
  [/^Add accent color for (.+)$/, "Agregar color de acento a $1"],
  [/^Add (.+) to favorites$/, "Agregar $1 a favoritos"],
  [/^Remove (.+) from favorites$/, "Quitar $1 de favoritos"],
  [/^Move (.+) up$/, "Subir $1"],
  [/^Move (.+) down$/, "Bajar $1"],
  [/^Show (.+) in the model picker$/, "Mostrar $1 en el selector de modelos"],
  [/^Authenticated · (.+)$/, "Sesión iniciada · $1"],
  [/^Fast mode · (.+)$/, (match, translate) => `Modo rápido · ${translate(match[1] ?? "")}`],
];

export const SIDEBAR_TABLE: LocaleTable = {
  text: SIDEBAR_TEXT,
  patterns: SIDEBAR_PATTERNS,
  functions: [snoozeMenuLabel],
};
export const THREAD_TABLE: LocaleTable = {
  // «8 models» under «Legacy models»: upstream writes « models» as its own node.
  raw: { " models": " modelos" },
  text: THREAD_TEXT,
  patterns: THREAD_PATTERNS,
};
export const SETTINGS_TABLE: LocaleTable = {
  // «Applying settings for <project> on|across <environment>», and «9 of 10 on» in Appearance.
  raw: { on: "en", across: "en", " of ": " de ", " on": " activos" },
  text: SETTINGS_TEXT,
  patterns: SETTINGS_PATTERNS,
};
export const SHELL_COMMON_TABLE: LocaleTable = { text: SHELL_COMMON_TEXT };
