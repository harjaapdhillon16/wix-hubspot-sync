import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WixDesignSystemProvider } from '@wix/design-system';
import '@wix/design-system/styles.global.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WixDesignSystemProvider features={{ newColorsBranding: true }}>
      <App />
    </WixDesignSystemProvider>
  </StrictMode>,
);
