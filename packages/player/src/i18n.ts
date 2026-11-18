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
  helpRemote: "Remote control: pair a phone",
  helpKick: "Disconnect every remote",
  helpFinish: "Finish, on the last slide (presenter view)",
  presenterTitle: "Presenter view",
  current: "Now",
  next: "Next",
  notes: "Notes",
  noNotes: "No notes for this slide.",
  end: "End of the presentation",
  endCue: "End of presentation · Esc to exit",
  finish: "Finish",
  finished: "Presentation finished: the audience screen is black. You can close this window.",
  backToPanel: "Back to panel",
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
  offlineUnverified:
    "Interactive presentation: online only. An offline copy is the static version.",
  scriptsStopped:
    "The interactive content stopped responding and was closed. Loading the static version of the slides…",
  scriptError: "A script of this slide failed",
  helpUnlock: "Unlock interactive mode (presenter password)",
  unlockTitle: "Unlock interactive mode",
  unlockText:
    "Enter the presenter password to run the code the owner approved for this presentation, in this tab only.",
  unlockNotOwner:
    "This is the presenter password, not the owner password. It cannot open the PPTaken panel.",
  unlockLabel: "Presenter password",
  unlockSubmit: "Unlock",
  unlockCancel: "Cancel",
  unlockBusy: "Unlocking…",
  unlockRequired: "Enter the presenter password.",
  unlockFailed:
    "That did not work. Check the presenter password. Only presentations whose code the owner approved can be unlocked.",
  unlockLocked: "Too many attempts. Try again in {n} seconds.",
  unlockNetwork: "Cannot reach the server. Interactive mode needs a connection.",
  unlockUnavailable:
    "Unlocked, but this presentation cannot run its code right now. It stays static.",
  unlockEnded:
    "Interactive mode ended (the presentation changed or the unlock expired). Press U to unlock again.",
  interactiveOn: "Interactive mode",
  interactiveOffline: "Interactive mode needs a connection. Unlock before you go offline.",
  linkInvalid: "This presentation link is no longer valid. Ask for a new one.",
  loadFailed: "Could not load the presentation.",
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
  helpRemote: "Control remoto: emparejar un teléfono",
  helpKick: "Desconectar todos los controles remotos",
  helpFinish: "Terminar, en la última diapositiva (vista del presentador)",
  presenterTitle: "Vista del presentador",
  current: "Ahora",
  next: "Siguiente",
  notes: "Notas",
  noNotes: "Esta diapositiva no tiene notas.",
  end: "Fin de la presentación",
  endCue: "Fin de la presentación · Esc para salir",
  finish: "Terminar",
  finished:
    "Presentación terminada: la pantalla del público está en negro. Ya puedes cerrar esta ventana.",
  backToPanel: "Volver al panel",
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
  offlineUnverified:
    "Presentación interactiva: solo con conexión. Una copia sin conexión es la versión estática.",
  scriptsStopped:
    "El contenido interactivo dejó de responder y se cerró. Cargando la versión estática de las diapositivas…",
  scriptError: "Falló un script de esta diapositiva",
  helpUnlock: "Desbloquear el modo interactivo (contraseña de presentador)",
  unlockTitle: "Desbloquear el modo interactivo",
  unlockText:
    "Escribe la contraseña de presentador para ejecutar el código que el propietario aprobó para esta presentación, solo en esta pestaña.",
  unlockNotOwner:
    "Es la contraseña de presentador, no la del propietario. No abre el panel de PPTaken.",
  unlockLabel: "Contraseña de presentador",
  unlockSubmit: "Desbloquear",
  unlockCancel: "Cancelar",
  unlockBusy: "Desbloqueando…",
  unlockRequired: "Escribe la contraseña de presentador.",
  unlockFailed:
    "No funcionó. Revisa la contraseña de presentador. Solo se pueden desbloquear presentaciones cuyo código aprobó el propietario.",
  unlockLocked: "Demasiados intentos. Vuelve a intentarlo en {n} segundos.",
  unlockNetwork: "No se puede contactar con el servidor. El modo interactivo necesita conexión.",
  unlockUnavailable:
    "Desbloqueada, pero esta presentación no puede ejecutar su código ahora. Sigue en versión estática.",
  unlockEnded:
    "El modo interactivo terminó (la presentación cambió o el desbloqueo caducó). Pulsa U para desbloquear de nuevo.",
  interactiveOn: "Modo interactivo",
  interactiveOffline:
    "El modo interactivo necesita conexión. Desbloquéalo antes de quedarte sin conexión.",
  linkInvalid: "Este enlace de presentación ya no es válido. Pide uno nuevo.",
  loadFailed: "No se pudo cargar la presentación.",
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
