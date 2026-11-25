import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './app.tsx';
import { bootstrapSession } from './lib/api.ts';
import { MODE } from './mode.ts';

async function start(): Promise<void> {
  let sessionError: unknown = null;
  if (MODE === 'local') {
    try {
      await bootstrapSession();
    } catch (error) {
      sessionError = error;
    }
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('index.html has no #root element');
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}>
        <App sessionError={sessionError} />
      </BrowserRouter>
    </StrictMode>,
  );
}

void start();
