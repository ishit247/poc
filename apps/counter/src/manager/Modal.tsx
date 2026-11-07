import { useEffect, type ReactNode } from 'react';

/** A confirm dialog for the manager's irreversible actions. Esc or a tap outside closes it. Rendered where it is used, so
 *  a row's own buttons and inputs stay inside the row. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog m-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
