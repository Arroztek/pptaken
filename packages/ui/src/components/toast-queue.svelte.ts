import type { IconName } from "../icons";

/** One action a toast offers (an "Undo"); running it dismisses the toast. */
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastItem {
  id: number;
  message: string;
  icon: IconName;
  /** ms before it hides itself. 0 keeps it until dismissed. */
  duration: number;
  action?: ToastAction;
}

let next = 1;

/** Tiny global toast queue. Render <ToastRegion /> once; call toast.show() anywhere. */
class ToastQueue {
  items: ToastItem[] = $state([]);

  show(
    message: string,
    options: { icon?: IconName; duration?: number; action?: ToastAction } = {},
  ): number {
    const item: ToastItem = {
      id: next++,
      message,
      icon: options.icon ?? "check",
      // A toast with an action stays a little longer: people need time to reach the button.
      duration: options.duration ?? (options.action ? 8000 : 4000),
      ...(options.action ? { action: options.action } : {}),
    };
    this.items = [...this.items.slice(-2), item]; // never more than three at once
    if (item.duration > 0) setTimeout(() => this.dismiss(item.id), item.duration);
    return item.id;
  }

  dismiss(id: number): void {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toast = new ToastQueue();
