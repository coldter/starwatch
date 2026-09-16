import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

export interface SearchBarProps {
  /** Current committed query (URL is the source of truth). */
  value: string;
  onSubmit: (q: string) => void;
  placeholder?: string;
  busy?: boolean;
  autoFocus?: boolean;
}

/**
 * Search input with the shared shortcuts: `/` or Cmd/Ctrl+K focus from
 * anywhere, Enter submits, Esc clears focus (docs/06 §3).
 */
export function SearchBar({ value, onSubmit, placeholder, busy = false, autoFocus = false }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;

      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();

        return;
      }

      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(draft.trim());
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      inputRef.current?.blur();
    }
  };

  return (
    <form className="searchbar" role="search" onSubmit={submit}>
      <span className="searchbar__icon" aria-hidden="true">
        ⌕
      </span>
      <label className="visually-hidden" htmlFor="starwatch-search">
        Search starred repositories
      </label>
      <input
        ref={inputRef}
        id="starwatch-search"
        className="searchbar__input"
        type="search"
        name="q"
        value={draft}
        placeholder={placeholder ?? "Search descriptions, topics, READMEs…"}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onInputKeyDown}
      />
      {busy ? (
        <span className="searchbar__busy" aria-hidden="true">
          ◐
        </span>
      ) : null}
      <button type="submit" className="btn btn--small searchbar__submit">
        Search
      </button>
      <kbd className="searchbar__kbd" aria-hidden="true">
        /
      </kbd>
    </form>
  );
}
