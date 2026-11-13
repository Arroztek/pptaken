import type { IconName } from "../icons";

export interface ToastItem {
  id: number;
  message: string;
  icon: IconName;
  /** ms before it hides itself. 0 keeps it until dismissed. */
  duration: number;
}

let next = 1;

/** Tiny global toast queue. Render <ToastRegion /> once; call toast.show() anywhere. */
class ToastQueue {
  items: ToastItem[] = $state([]);

  show(message: string, options: { icon?: IconName; duration?: number } = {}): number {
    const item: ToastItem = {
      id: next++,
      message,
      icon: options.icon ?? "check",
      duration: options.duration ?? 4000,
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
