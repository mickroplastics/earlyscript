# Asistente de primer arranque (2 de noviembre de 2026)

Cuatro pasos en español que reemplazan al asistente de T3 Code (Connect / Agents / Projects).
Cada archivo tiene un dueño; nadie edita un archivo ajeno. La integración la hace Fable al fusionar.

| Archivo                                                            | Dueño (rama)                 | Contenido                                                                                       |
| ------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `steps.ts`                                                         | base (congelado)             | Ids, orden y `OnboardingStepProps`.                                                             |
| `WelcomeWizard.tsx` de upstream, carcasa, registro de aceptaciones | `es/onboarding-shell`        | Navegación, cabecera, texto de privacidad, reabrir desde Ajustes, RPC `editorial.onboarding.*`. |
| `DataConsentStep.tsx`                                              | `es/onboarding-data`         | Fuentes, términos, retención, borrado, qué viaja a proveedores; aceptación.                     |
| `ProvidersStep.tsx`                                                | `es/onboarding-providers`    | Proveedor conectado, modelo de redacción, tope mensual.                                         |
| `StudioStep.tsx`                                                   | `es/onboarding-studio`       | Perfil editorial editable y persistido.                                                         |
| `ModelDownloadCard.tsx`                                            | `es/onboarding-engine-model` | Estado y descarga del modelo local, con progreso.                                               |
| `EngineStep.tsx`, estado vacío de Tendencias                       | `es/onboarding-engine-run`   | Nocturna (hora, zona) y primera corrida «Ejecutar ahora».                                       |

Reglas: texto visible en español; código y comentarios en inglés; nada en archivos de upstream
salvo enganches de una línea anotados en `docs/upstream-divergence.md`.
