// SPDX-License-Identifier: Apache-2.0
// Texts of the remote-control interfaces (the pairing panel on the laptop, the phone page), English and Spanish.

export type Locale = "en" | "es";

const en = {
  // Panel (laptop)
  panelTitle: "Remote control",
  panelScan: "Scan with your phone to control this presentation.",
  panelExpires: "Code expires in",
  panelNewCode: "New code",
  panelClose: "Close",
  panelKick: "Disconnect all remotes (K)",
  panelDevices: "Paired devices",
  panelNoDevices: "No phone paired yet.",
  panelPending: "waiting for approval",
  panelApproved: "approved",
  panelOnline: "connected",
  panelOffline: "not connected",
  panelAllow: "Allow",
  panelRemove: "Remove",
  panelDeny: "Deny",
  panelLoopback:
    "This page is open on localhost, which your phone cannot reach. Pick the address of this computer on your network:",
  panelNoLan:
    "No network address was found. Set PPTAKEN_PUBLIC_URL to an address your phone can reach.",
  panelHttp:
    "Plain HTTP: remote commands, speaker notes and the pairing code travel unencrypted on this network. Use HTTPS on untrusted networks.",
  panelError: "Could not create a pairing code. Try again.",
  panelLimit: "Two remotes are already paired. Remove one to pair another phone.",
  promptAllow: "Allow {device} · {code}?",
  promptKeys: "Enter: allow · Esc: deny",
  kicked: "Every remote was disconnected.",
  // Phone
  phoneTitle: "PPTaken remote",
  phoneScan: "Scan the QR code shown on the presenter's laptop (press R in the presentation).",
  phonePairing: "Pairing…",
  phonePending: "Waiting for approval on the laptop. Check that it shows this code:",
  phoneConnecting: "Connecting…",
  phoneReady: "Connected",
  phoneScreenOff: "Screen offline",
  phoneRevoked: "This phone was disconnected by the presenter. Scan a new code to pair again.",
  phoneEnded: "The presentation ended.",
  phoneExpired: "This code expired or was already used. Ask for a new one (press R on the laptop).",
  phoneLimit: "Two remotes are already paired with this presentation.",
  phoneError: "Something went wrong. Try scanning again.",
  phoneRateLimited: "Too many attempts. Wait a minute and try again.",
  phonePrev: "Previous",
  phoneNext: "Next",
  phoneFirst: "First",
  phoneLast: "Last",
  phoneBlack: "Black screen",
  phoneLaser: "Laser",
  phoneNotes: "Notes",
  phoneNoNotes: "No notes for this slide.",
  phoneNextSlide: "Next slide",
  phoneEnd: "End of the presentation",
  phoneClock: "Clock",
  phoneStart: "Start",
  phonePause: "Pause",
  phoneReset: "Reset",
  phoneAhead: "ahead",
  phoneBehind: "behind",
  phoneOnTime: "On time",
  phoneIsBlack: "The audience screen is black.",
  phoneSleep: "Keep this screen on: the phone may lock and disconnect while idle.",
  phoneHttp: "Plain HTTP: commands and notes travel unencrypted on this network.",
} as const;

export type RemoteLabelKey = keyof typeof en;
export type RemoteLabels = Record<RemoteLabelKey, string>;

const es: RemoteLabels = {
  panelTitle: "Control remoto",
  panelScan: "Escanea con tu teléfono para controlar esta presentación.",
  panelExpires: "El código caduca en",
  panelNewCode: "Código nuevo",
  panelClose: "Cerrar",
  panelKick: "Desconectar todos los controles (K)",
  panelDevices: "Dispositivos emparejados",
  panelNoDevices: "Aún no hay ningún teléfono emparejado.",
  panelPending: "esperando aprobación",
  panelApproved: "aprobado",
  panelOnline: "conectado",
  panelOffline: "sin conexión",
  panelAllow: "Permitir",
  panelRemove: "Quitar",
  panelDeny: "Rechazar",
  panelLoopback:
    "Esta página está abierta en localhost, que tu teléfono no puede alcanzar. Elige la dirección de este ordenador en tu red:",
  panelNoLan:
    "No se encontró ninguna dirección de red. Configura PPTAKEN_PUBLIC_URL con una dirección que tu teléfono pueda alcanzar.",
  panelHttp:
    "HTTP sin cifrar: los comandos, las notas del orador y el código de emparejamiento viajan sin cifrar por esta red. Usa HTTPS en redes que no sean de confianza.",
  panelError: "No se pudo crear un código de emparejamiento. Inténtalo de nuevo.",
  panelLimit: "Ya hay dos controles emparejados. Quita uno para emparejar otro teléfono.",
  promptAllow: "¿Permitir {device} · {code}?",
  promptKeys: "Enter: permitir · Esc: rechazar",
  kicked: "Se desconectaron todos los controles remotos.",
  phoneTitle: "Control remoto de PPTaken",
  phoneScan:
    "Escanea el código QR que aparece en el portátil del presentador (pulsa R en la presentación).",
  phonePairing: "Emparejando…",
  phonePending: "Esperando aprobación en el portátil. Comprueba que muestra este código:",
  phoneConnecting: "Conectando…",
  phoneReady: "Conectado",
  phoneScreenOff: "Pantalla sin conexión",
  phoneRevoked:
    "El presentador desconectó este teléfono. Escanea un código nuevo para volver a emparejarlo.",
  phoneEnded: "La presentación terminó.",
  phoneExpired: "Este código caducó o ya se usó. Pide uno nuevo (pulsa R en el portátil).",
  phoneLimit: "Ya hay dos controles emparejados con esta presentación.",
  phoneError: "Algo salió mal. Vuelve a escanear el código.",
  phoneRateLimited: "Demasiados intentos. Espera un minuto y vuelve a intentarlo.",
  phonePrev: "Anterior",
  phoneNext: "Siguiente",
  phoneFirst: "Primera",
  phoneLast: "Última",
  phoneBlack: "Pantalla negra",
  phoneLaser: "Láser",
  phoneNotes: "Notas",
  phoneNoNotes: "Esta diapositiva no tiene notas.",
  phoneNextSlide: "Siguiente diapositiva",
  phoneEnd: "Fin de la presentación",
  phoneClock: "Reloj",
  phoneStart: "Iniciar",
  phonePause: "Pausar",
  phoneReset: "Reiniciar",
  phoneAhead: "adelantado",
  phoneBehind: "atrasado",
  phoneOnTime: "A tiempo",
  phoneIsBlack: "La pantalla del público está en negro.",
  phoneSleep:
    "Mantén la pantalla encendida: el teléfono puede bloquearse y desconectarse si está inactivo.",
  phoneHttp: "HTTP sin cifrar: los comandos y las notas viajan sin cifrar por esta red.",
};

export const REMOTE_LABELS: Readonly<Record<Locale, RemoteLabels>> = { en, es };

export function remoteLabels(locale: Locale | undefined): RemoteLabels {
  return locale === "es" ? es : en;
}

/** The best supported locale for a list such as `navigator.languages`; English is the fallback. */
export function pickRemoteLocale(preferred: readonly string[] = []): Locale {
  for (const tag of preferred) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (base === "es" || base === "en") return base;
  }
  return "en";
}

/** Replaces `{name}` placeholders (values are shown with textContent, never as HTML). */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "");
}
