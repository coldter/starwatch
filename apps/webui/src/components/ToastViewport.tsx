export type ToastTone = "info" | "error";

export interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
}

export interface ToastViewportProps {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}

export function ToastViewport({ items, onDismiss }: ToastViewportProps) {
  if (items.length === 0) return null;
  return (
    <div className="toasts">
      {items.map((item) => (
        <div
          key={item.id}
          className={`toast toast--${item.tone}`}
          role={item.tone === "error" ? "alert" : "status"}
        >
          <div className="toast__text">
            <p className="toast__title">{item.title}</p>
            {item.body ? <p className="toast__body">{item.body}</p> : null}
          </div>
          <button
            type="button"
            className="toast__close"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(item.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
