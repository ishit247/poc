// Per-tablet display choices (text size, light/dark). Kept in localStorage and applied as data attributes on <html>,
// which styles.css reads. Nothing here touches sales data, and a blocked localStorage just means the defaults.
export type FontSize = 's' | 'm' | 'l';
export type Theme = 'light' | 'dark';

const read = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try { const v = localStorage.getItem(key); return allowed.includes(v as T) ? (v as T) : fallback; } catch { return fallback; }
};

export const getFont = (): FontSize => read('pos.font', ['s', 'm', 'l'], 'm');
export const getTheme = (): Theme => read('pos.theme', ['light', 'dark'], 'light');

export function setFont(v: FontSize): void {
  try { localStorage.setItem('pos.font', v); } catch { /* keep it for this session only */ }
  document.documentElement.dataset.font = v;
}
export function setTheme(v: Theme): void {
  try { localStorage.setItem('pos.theme', v); } catch { /* keep it for this session only */ }
  document.documentElement.dataset.theme = v;
}

/** Call once before the first render, so there is no flash of the wrong theme. */
export function applyPrefs(): void {
  document.documentElement.dataset.font = getFont();
  document.documentElement.dataset.theme = getTheme();
}
