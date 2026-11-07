import { useEffect, useState, type ReactNode } from 'react';
import { Branding } from './Branding.tsx';

const STEPS = [
  { title: 'Enrol this tablet', hint: 'Enter the code from your manager' },
  { title: 'Connect', hint: 'Load the menu and staff list' },
  { title: 'Sign in', hint: 'Pick your name and enter your PIN' },
];

/** The frame for every screen shown before a tablet is enrolled: a rail saying where you are, the form beside it. */
export function EnrolShell({ step, note = 'Managers: sign in to create a code for another counter.', children }: { step: 1 | 2 | 3; note?: string; children: ReactNode }) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return (
    <div className="en-page">
      <div className="en-top">
        <span className={online ? 'ok' : 'warn'}>●</span> {online ? 'Online' : 'Offline'}
        <span className="spacer" />
        <span>Setting up a counter needs a connection</span>
      </div>
      <div className="en-shell">
        <aside className="en-rail">
          <div><Branding /><small>Counter setup</small></div>
          <ol className="en-steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className={i + 1 < step ? 'done' : i + 1 === step ? 'cur' : ''} aria-current={i + 1 === step ? 'step' : undefined}>
                <span className="n">{i + 1 < step ? '✓' : i + 1}</span>
                <div><b>{s.title}</b><small>{s.hint}</small></div>
              </li>
            ))}
          </ol>
          <div className="en-note">{note}</div>
        </aside>
        <section className="en-pane">{children}</section>
      </div>
    </div>
  );
}
