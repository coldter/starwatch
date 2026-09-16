import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ToastViewport, type ToastItem, type ToastTone } from "../components/ToastViewport";

export interface ToastInput {
  title: string;
  body?: string;
  tone?: ToastTone;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextToastId = 1;

export function useToast(): (input: ToastInput) => void {
  const context = useContext(ToastContext);

  if (context === null) throw new Error("useToast must be used inside <ToastProvider>");

  return context.toast;
}

/** App-level toast host — errors surface here instead of `alert()`. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    const timer = timers.current.get(id);

    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextToastId++;
      const item: ToastItem = { id, title: input.title, body: input.body, tone: input.tone ?? "info" };
      setItems((prev) => [...prev.slice(-3), item]);
      const timeout = window.setTimeout(() => dismiss(id), item.tone === "error" ? 8000 : 5000);
      timers.current.set(id, timeout);
    },
    [dismiss]
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
