import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import './index.css';
import App from './App.jsx';

async function bootstrap() {
  if (Capacitor.getPlatform() === 'web') {
    const { defineCustomElements } = await import('jeep-sqlite/loader');
    defineCustomElements(window);
    const jeepSqliteEl = document.createElement('jeep-sqlite');
    document.body.appendChild(jeepSqliteEl);
    await customElements.whenDefined('jeep-sqlite');
  }

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

bootstrap();
