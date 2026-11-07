import { useEffect, useRef, type ReactNode } from 'react';

/** A native <dialog>: focus is trapped, Esc closes it, and the page behind is inert. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    const close = () => onClose();
    d.addEventListener('close', close);
    return () => d.removeEventListener('close', close);
  }, [onClose]);
  return (
    <dialog ref={ref} aria-label={title} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="in"><h3>{title}</h3>{children}</div>
    </dialog>
  );
}

/** A yes/no question for an action that cannot be taken back. */
export function Confirm({ title, message, label, danger, onYes, onClose }: { title: string; message: string; label: string; danger?: boolean; onYes: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="muted">{message}</div>
      <div className="acts">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'danger solid' : 'primary'}`} data-testid="confirm-yes" onClick={() => { onClose(); onYes(); }}>{label}</button>
      </div>
    </Modal>
  );
}
