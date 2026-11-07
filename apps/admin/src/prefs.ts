// Theme and text size are per-browser choices, kept in localStorage and applied as data attributes on <html>.
export type Theme = 'light' | 'dark';
export type FontSize = 's' | 'm' | 'l';
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* a convenience only */ } };

export const getTheme = (): Theme => (read('console-theme') === 'dark' ? 'dark' : 'light');
export const getFont = (): FontSize => { const v = read('console-font'); return v === 's' || v === 'l' ? v : 'm'; };
export function setTheme(t: Theme) { write('console-theme', t); document.documentElement.dataset.theme = t; }
export function setFont(f: FontSize) { write('console-font', f); document.documentElement.dataset.font = f; }
export function applyPrefs() { document.documentElement.dataset.theme = getTheme(); document.documentElement.dataset.font = getFont(); }
