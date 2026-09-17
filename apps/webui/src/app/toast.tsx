import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  AnimatedToastStack,
  type AnimatedToast,
  type ToastStatus,
  useAnimatedToastStack,
} from "@/components/motion/animated-toast-stack";

/**
 * The app's single notification channel. Every user-visible outcome that is not
 * part of the page (a failed action, a started index run, a copied URL) goes
 * through here, and `AnimatedToastStack` owns the presentation.
 *
 * Toasts are status-typed rather than free-form: `error` marks the ones screen
 * readers announce assertively and keeps them on screen longer, `loading`
 * returns an id the caller can `update()` once the work settles.
 */
export interface ToastOptions {
  title: string;
  description?: string;
  status?: ToastStatus;
  /** Milliseconds on screen; `0` keeps it until it is dismissed or updated. */
  duration?: number;
  action?: { label: string; onClick: (toast: AnimatedToast) => void };
}

export interface ToastApi {
  toast: (options: ToastOptions) => string;
  info: (title: string, description?: string) => string;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  loading: (title: string, description?: string) => string;
  update: (id: string, patch: Partial<ToastOptions>) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);

  if (api === null) throw new Error("useToast must be used inside <ToastProvider>");

  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { toasts, showToast, updateToast, dismissToast } = useAnimatedToastStack({
    defaultDuration: 5200,
    limit: 4,
  });

  const api = useMemo<ToastApi>(
    () => ({
      toast: (options) =>
        showToast({
          title: options.title,
          description: options.description,
          status: options.status ?? "info",
          duration: options.duration ?? (options.status === "error" ? 9000 : undefined),
          action: options.action,
        }),
      info: (title, description) => showToast({ title, description, status: "info" }),
      success: (title, description) => showToast({ title, description, status: "success" }),
      error: (title, description) =>
        showToast({ title, description, status: "error", duration: 9000 }),
      loading: (title, description) =>
        showToast({ title, description, status: "loading", duration: 0 }),
      update: (id, patch) => updateToast(id, patch),
      dismiss: (id) => dismissToast(id),
    }),
    [showToast, updateToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <AnimatedToastStack toasts={toasts} onDismiss={dismissToast} position="bottom-right" portal />
    </ToastContext.Provider>
  );
}
