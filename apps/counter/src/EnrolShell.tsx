import { useEffect, useState, type ReactNode } from 'react';
import { Branding } from './Branding.tsx';
import { LANGS, setLang, t, useLang, useT } from './i18n.ts';

const STEPS = [
  { title: 'Enrol this tablet', hint: 'Enter the code from your manager' },
  { title: 'Connect', hint: 'Load the menu and staff list' },
  { title: 'Sign in', hint: 'Pick your name and enter your PIN' },
];

/** The frame for every screen shown before a tablet is enrolled: a rail saying where you are, the form beside it. */
export function EnrolShell({ step, note, children }: { step: 1 | 2 | 3; note?: string; children: ReactNode }) {
  useT();
  const lang = useLang();
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return (
    <div className="en-page">
      <div className="en-top">
        <span className={online ? 'ok' : 'warn'}>●</span> {online ? t('Online') : t('Offline')}
        <span className="spacer" />
        <span>{t('Setting up a counter needs a connection')}</span>
        <span className="seg" role="group" aria-label={t('Language')} style={{ marginLeft: 12 }}>
          {LANGS.map((l) => <button key={l.code} type="button" data-testid={`enrol-lang-${l.code}`} lang={l.code} className={lang === l.code ? 'active' : ''} aria-pressed={lang === l.code} onClick={() => setLang(l.code)}>{l.label}</button>)}
        </span>
      </div>
      <div className="en-shell">
        <aside className="en-rail">
          <div><Branding /><small>{t('Counter setup')}</small></div>
          <ol className="en-steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className={i + 1 < step ? 'done' : i + 1 === step ? 'cur' : ''} aria-current={i + 1 === step ? 'step' : undefined}>
                <span className="n">{i + 1 < step ? '✓' : i + 1}</span>
                <div><b>{t(s.title)}</b><small>{t(s.hint)}</small></div>
              </li>
            ))}
          </ol>
          <div className="en-note">{note ?? t('Managers: sign in to create a code for another counter.')}</div>
        </aside>
        <section className="en-pane">{children}</section>
      </div>
    </div>
  );
}
