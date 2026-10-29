import { useEffect, useState } from 'react';

/** Name and logo for the sign-in screens, by this address. Online only; shows nothing if it cannot be fetched. */
export function Branding() {
  const [b, setB] = useState<{ name: string; logo: { sha256: string } | null } | null>(null);
  useEffect(() => {
    fetch('/api/branding').then((r) => (r.ok ? r.json() : null)).then(setB).catch(() => setB(null));
  }, []);
  if (!b) return null;
  return (
    <div className="brand" data-testid="branding">
      {b.logo && <img data-testid="brand-logo" src={`/api/branding/logo?v=${b.logo.sha256}`} alt="" />}
      <strong>{b.name}</strong>
    </div>
  );
}
