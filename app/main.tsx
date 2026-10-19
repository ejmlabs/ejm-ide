import { TooltipProvider } from '@radix-ui/react-tooltip';
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/jetbrains-mono/latin-400.css';
import './styles.css';
import './lib/theme';
import App from './App';
import { initializeSyntaxHighlighting } from './lib/monaco';

const root = document.getElementById('root');
if (!root) throw new Error('ejm-ide could not find its root element.');

async function start(element: HTMLElement) {
  try {
    await initializeSyntaxHighlighting();
  } catch (error) {
    console.warn('Rich syntax highlighting could not start. Using bundled syntax colors.', error);
  }
  ReactDOM.createRoot(element).render(
    <React.StrictMode>
      <TooltipProvider delayDuration={450}>
        <App />
      </TooltipProvider>
    </React.StrictMode>,
  );
}

void start(root);
