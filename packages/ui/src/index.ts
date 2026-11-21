// @pptaken/ui: design tokens and Svelte 5 components for PPTaken.
// Import the CSS once at the app root:
//   import "@pptaken/ui/fonts.css";      (or fonts-audience.css on audience pages)
//   import "@pptaken/ui/tokens.css";
//   import "@pptaken/ui/components.css";
// Never load these inside the deck iframe (05 §11, §12).

export { default as BigCode } from "./components/BigCode.svelte";
export { default as Button } from "./components/Button.svelte";
export { default as Card } from "./components/Card.svelte";
export { default as CopyField } from "./components/CopyField.svelte";
export { default as DeckCard } from "./components/DeckCard.svelte";
export { default as Dialog } from "./components/Dialog.svelte";
export { default as EmptyState } from "./components/EmptyState.svelte";
export { default as FramedQR } from "./components/FramedQR.svelte";
export { default as Icon } from "./components/Icon.svelte";
export { default as IconButton } from "./components/IconButton.svelte";
export { default as Kbd } from "./components/Kbd.svelte";
export type { LoaderSize } from "./components/Loader.svelte";
export { default as Loader } from "./components/Loader.svelte";
export { default as Logo } from "./components/Logo.svelte";
export type { Tone } from "./components/Notice.svelte";
export { default as Notice } from "./components/Notice.svelte";
export type { Status } from "./components/StatusBadge.svelte";
export { default as StatusBadge } from "./components/StatusBadge.svelte";
export { default as Table } from "./components/Table.svelte";
export { default as Tabs } from "./components/Tabs.svelte";
export { default as TextField } from "./components/TextField.svelte";
export {
  applyTheme,
  default as ThemeToggle,
  readTheme,
  type ThemeChoice,
} from "./components/ThemeToggle.svelte";
export { default as Toast } from "./components/Toast.svelte";
export { default as ToastRegion } from "./components/ToastRegion.svelte";
export { type ToastAction, type ToastItem, toast } from "./components/toast-queue.svelte";
export {
  createTranslator,
  type Dictionary,
  dictionaries,
  en,
  es,
  getI18n,
  type Locale,
  type MessageKey,
  pickLocale,
  setI18n,
  type Translate,
} from "./i18n";
export { type IconName, icons } from "./icons";
export { logo } from "./logo";
export { cssVar, type SemanticColor, type ThemeMode, type Tokens, tokens } from "./tokens";
