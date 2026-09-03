import { useState } from 'react';
import { applyTheme, getTheme, THEMES, type Theme } from '../theme';

const LABEL: Record<Theme, string> = {
  auto: '🖥 Auto',
  light: '☀️ Light',
  dark: '🌙 Dark',
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme);

  const cycle = () => {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
    applyTheme(next);
    setTheme(next);
  };

  return (
    <button className="theme-toggle" onClick={cycle} title="Switch theme" aria-label="Switch theme">
      {LABEL[theme]}
    </button>
  );
}
