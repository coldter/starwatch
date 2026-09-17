/**
 * Clipboard writes with one honest answer: `true` only when the text really
 * landed. `navigator.clipboard` is absent in non-secure contexts, so the
 * access itself has to be guarded, not just the promise.
 */
export async function copyText(value: string): Promise<boolean> {
  if (!navigator.clipboard) return false;

  try {
    await navigator.clipboard.writeText(value);

    return true;
  } catch {
    return false;
  }
}
