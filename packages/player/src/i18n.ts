// SPDX-License-Identifier: Apache-2.0
// Texts of the player's own interface (key help overlay, presenter view), English first with Spanish. The
// player is framework-free, so this is a plain dictionary; the app picks the locale and passes it in.

export type Locale = "en" | "es";

const en = {
  helpTitle: "Keys",
  helpNext: "Next",
  helpPrev: "Previous",
  helpFirstLast: "First / last slide",
  helpBlack: "Black screen",
  helpFullscreen: "Full screen",
  helpOverview: "Overview",
  helpPresenter: "Presenter view",
  helpPrint: "Print / PDF",
  helpHelp: "This help",
  helpClose: "Close",
  helpClock: "Start / pause the clock (presenter view)",
  helpClockReset: "Reset the clock (presenter view)",
  presenterTitle: "Presenter view",
  current: "Now",
  next: "Next",
  notes: "Notes",
  noNotes: "No notes for this slide.",
  end: "End of the presentation",
  slide: "Slide",
  step: "Step",
  elapsed: "Elapsed",
  target: "Target",
  start: "Start",
  pause: "Pause",
  reset: "Reset",
  prevButton: "Previous",
  nextButton: "Next",
  ahead: "ahead",
  behind: "behind",
  onTime: "On time",
  pace: "Pace by section",
  noSection: "No section",
  planned: "Planned",
  actual: "Actual",
  black: "The audience screen is black.",
  loading: "Loading…",
  loadError: "Could not load the presenter view.",
  offlineTitle: "Offline",
  offlineLoading: "Preparing to present offline…",
  offlineReady: "Ready to present offline.",
  offlinePartial: "Some resources could not be loaded.",
  offlineCopy: "Ready to present offline. A copy is saved on this device.",
  offlineUnavailable:
    "This presentation is not available offline. Open it once with a connection to keep a copy on this device.",
} as const;

export type LabelKey = keyof typeof en;
export type Labels = Record<LabelKey, string>;

const es: Labels = {
  helpTitle: "Teclas",
  helpNext: "Siguiente",
  helpPrev: "Anterior",
  helpFirstLast: "Primera / última diapositiva",
  helpBlack: "Pantalla negra",
  helpFullscreen: "Pantalla completa",
  helpOverview: "Vista general",
  helpPresenter: "Vista del presentador",
  helpPrint: "Imprimir / PDF",
  helpHelp: "Esta ayuda",
  helpClose: "Cerrar",
  helpClock: "Iniciar / pausar el reloj (vista del presentador)",
  helpClockReset: "Reiniciar el reloj (vista del presentador)",
  presenterTitle: "Vista del presentador",
  current: "Ahora",
  next: "Siguiente",
  notes: "Notas",
  noNotes: "Esta diapositiva no tiene notas.",
  end: "Fin de la presentación",
  slide: "Diapositiva",
  step: "Paso",
  elapsed: "Transcurrido",
  target: "Objetivo",
  start: "Iniciar",
  pause: "Pausar",
  reset: "Reiniciar",
  prevButton: "Anterior",
  nextButton: "Siguiente",
  ahead: "adelantado",
  behind: "atrasado",
  onTime: "A tiempo",
  pace: "Ritmo por sección",
  noSection: "Sin sección",
  planned: "Previsto",
  actual: "Real",
  black: "La pantalla del público está en negro.",
  loading: "Cargando…",
  loadError: "No se pudo cargar la vista del presentador.",
  offlineTitle: "Sin conexión",
  offlineLoading: "Preparando para presentar sin conexión…",
  offlineReady: "Lista para presentar sin conexión.",
  offlinePartial: "Algunos recursos no se pudieron cargar.",
  offlineCopy: "Lista para presentar sin conexión. Hay una copia guardada en este dispositivo.",
  offlineUnavailable:
    "Esta presentación no está disponible sin conexión. Ábrela una vez con conexión para guardar una copia en este dispositivo.",
};

export const LABELS: Readonly<Record<Locale, Labels>> = { en, es };

/** The best supported locale for a list such as `navigator.languages`; English is the fallback. */
export function pickLocale(preferred: readonly string[] = []): Locale {
  for (const tag of preferred) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (base === "es" || base === "en") return base;
  }
  return "en";
}

export function labelsFor(locale: Locale | undefined): Labels {
  return locale === "es" ? es : en;
}
