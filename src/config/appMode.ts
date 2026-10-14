const env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : (process.env as any) || {};
export const APP_MODE = (env.VITE_APP_MODE || 'production').toLowerCase();
export const isDemoMode = APP_MODE === 'demo';

export function assertProductionSafeMode(): void {
  if (isDemoMode) {
    console.warn('[GAIN] Demo mode is active. Do not use this build for live public operations.');
  }
}
