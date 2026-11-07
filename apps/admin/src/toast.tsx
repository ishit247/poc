import { useEffect, useState } from 'react';

const EVENT = 'console-toast';
/** A short message at the bottom of the screen, for results the user did not click through to (saved, copied, imported). */
export const toast = (message: string) => window.dispatchEvent(new CustomEvent(EVENT, { detail: message }));

export function Toaster() {
  const [items, setItems] = useState<{ id: number; text: string }[]>([]);
  useEffect(() => {
    let n = 0;
    const on = (e: Event) => {
      const id = ++n;
      setItems((p) => [...p, { id, text: String((e as CustomEvent).detail) }]);
      setTimeout(() => setItems((p) => p.filter((x) => x.id !== id)), 2600);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return <div className="toast-host" role="status" aria-live="polite">{items.map((i) => <div key={i.id} className="toast">{i.text}</div>)}</div>;
}
