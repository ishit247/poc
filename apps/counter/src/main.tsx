import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

// Only in the production build: in dev the module URLs are not hashed and a cache would serve stale code.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
