# Asistente de primer arranque

Bienvenida y cuatro pasos en español que reemplazan al asistente de T3 Code (Connect / Agents /
Projects). Diseño onb-b del 13 de noviembre de 2026: cada paso en dos columnas, a la izquierda lo
que se elige y a la derecha un ejemplo fijo de lo que produce (`wizardLayout.tsx`,
`onboardingExamples.ts`).

| Archivo                                              | Contenido                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `steps.ts`                                           | Ids (los del contrato), orden, etiquetas y `OnboardingStepProps`.                               |
| `EarlyscriptWizard.tsx`, `EarlyscriptWizardView.tsx` | Carcasa: bienvenida, cabecera, «Seguir más tarde», reanudación, registro de aceptaciones.       |
| `setupProgress.ts`                                   | Asistente sin terminar y paso alcanzado, según el servidor; espera del modelo.                  |
| `DataConsentStep.tsx`, `dataConsent.logic.ts`        | «Tus datos»: fuentes, términos, qué sale; el texto aceptado y su `policyHash`, sin cambios.     |
| `ProvidersStep.tsx`                                  | «Asistente de IA»: proveedor con sesión, modelo de redacción, tope mensual.                     |
| `StudioStep.tsx`                                     | «Tu canal»: perfil editable; cada cambio guardado crea una versión.                             |
| `EngineStep.tsx`, `ModelDownloadCard.tsx`            | «Revisión nocturna»: modelo local, hora, y la primera revisión, que arranca sola con el modelo. |

Fuera de esta carpeta: `../FirstRunCard.tsx` (bandeja vacía y primera revisión),
`../FirstReviewPhases.tsx` (las cinco fases) y `../FinishSetupEntry.tsx` («Terminar de
configurar» en la barra lateral). Reglas: texto visible en español; código y comentarios en
inglés; nada en archivos de upstream salvo enganches de una línea anotados en
`docs/upstream-divergence.md`.
