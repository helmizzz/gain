import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import { initClientObservability, reportWebVital } from './services/observabilityService';
import { GoogleOAuthProvider } from '@react-oauth/google';

initClientObservability();
onCLS(reportWebVital);
onFCP(reportWebVital);
onINP(reportWebVital);
onLCP(reportWebVital);
onTTFB(reportWebVital);

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || 'dummy-client-id';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={googleClientId}>
      <App />
    </GoogleOAuthProvider>
  </StrictMode>,
);
