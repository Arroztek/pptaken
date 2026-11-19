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
    "The interactive part stopped responding. Showing the static version of the slides…",
  noticeErrorWhat:
    "Something went wrong in this deck's interactive code. The slides still show, but some interactive parts may not work.",
  noticeStoppedWhat:
    "This deck's interactive code stopped responding, so the presentation switched to the static version.",
  noticeFixDo:
    "Ask your agent to check the script errors of this presentation and fix them, then reload the presentation.",
  noticePendingWhat:
    "This deck's interactive code is not approved yet, so it shows the static version.",
  noticePendingDo:
    "Open the presentation's page in PPTaken, review the code and approve it, then reload the presentation.",
  noticeOffWhat:
    "Interactive code is turned off on this PPTaken server, so the presentation shows its static version.",
  noticeOffDo:
    "To run it, whoever runs this PPTaken server must turn scripts on (PPTAKEN_SCRIPTS=owner).",
  noticeOpenErrors: "See the script errors",
  noticeOpenReview: "Review and approve",
  newTab: "(opens in a new tab)",
  noticeCopy: "Copy a message for my agent",
  noticeCopied: "Copied",
  noticeCopyFailed: "Could not copy: select the message below",
  agentMessage:
    'The interactive code of my presentation "{title}" ({id}) shows errors. Please read its script_errors with get_presentation, fix the scripts and tell me when to approve them again.',
  loadSlow:
    "This presentation is taking too long to load. Check your connection and reload this page. If you opened it inside an embedded preview, open it in your regular browser.",
  stoppedFault:
    "The presentation stopped because its content did something unexpected. Reload this page. If it happens again, open the presentation's page in PPTaken and check its script errors.",
  openDeckPage: "Open the presentation's page",
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
  loadFailed: "Could not load the presentation. Check your connection and reload this page.",
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
    "La parte interactiva dejó de responder. Mostrando la versión estática de las diapositivas…",
  noticeErrorWhat:
    "Algo falló en el código interactivo de esta presentación. Las diapositivas se siguen viendo, pero algunas partes interactivas pueden no funcionar.",
  noticeStoppedWhat:
    "El código interactivo de esta presentación dejó de responder, así que se cambió a la versión estática.",
  noticeFixDo:
    "Pide a tu agente que revise los errores de script de esta presentación y los corrija; luego vuelve a cargar la presentación.",
  noticePendingWhat:
    "El código interactivo de esta presentación todavía no está aprobado, así que se muestra la versión estática.",
  noticePendingDo:
    "Abre la página de la presentación en PPTaken, revisa el código y apruébalo; luego vuelve a cargar la presentación.",
  noticeOffWhat:
    "El código interactivo está desactivado en este servidor de PPTaken, así que la presentación muestra su versión estática.",
  noticeOffDo:
    "Para ejecutarlo, quien administra este servidor de PPTaken debe activar los scripts (PPTAKEN_SCRIPTS=owner).",
  noticeOpenErrors: "Ver los errores de script",
  noticeOpenReview: "Revisar y aprobar",
  newTab: "(se abre en una pestaña nueva)",
  noticeCopy: "Copiar un mensaje para mi agente",
  noticeCopied: "Copiado",
  noticeCopyFailed: "No se pudo copiar: selecciona el mensaje de abajo",
  agentMessage:
    'El código interactivo de mi presentación "{title}" ({id}) tiene errores. Lee sus script_errors con get_presentation, corrige los scripts y avísame cuándo debo aprobarlos de nuevo.',
  loadSlow:
    "Esta presentación está tardando demasiado en cargar. Revisa tu conexión y vuelve a cargar esta página. Si la abriste dentro de una vista previa integrada, ábrela en tu navegador habitual.",
  stoppedFault:
    "La presentación se detuvo porque su contenido hizo algo inesperado. Vuelve a cargar esta página. Si se repite, abre la página de la presentación en PPTaken y revisa sus errores de script.",
  openDeckPage: "Abrir la página de la presentación",
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
  loadFailed:
    "No se pudo cargar la presentación. Revisa tu conexión y vuelve a cargar esta página.",
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
