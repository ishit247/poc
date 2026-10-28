import { useEffect, useState } from 'react';

// Shell only. The offline sale screen, local DB and outbox are phase 3.
export function App() {
  const [api, setApi] = useState<'checking' | 'up' | 'down'>('checking');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? 'up' : 'down'))
      .catch(() => 'down')
      .then((s) => setApi(s as 'up' | 'down'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Cafeteria counter</h1>
      <p>Server: {api}</p>
    </main>
  );
}
