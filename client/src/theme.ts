export type Theme = 'auto' | 'light' | 'dark';

const KEY = 'theme';
export const THEMES: Theme[] = ['auto', 'light', 'dark'];

export function getTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

// 'auto' removes the attribute so the CSS prefers-color-scheme rules take over.
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
    localStorage.removeItem(KEY);
  } else {
    root.setAttribute('data-theme', theme);
    localStorage.setItem(KEY, theme);
  }
}
