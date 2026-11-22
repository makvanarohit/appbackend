// In development the Vite proxy forwards /api to the backend, so a relative URL works.
// In a build, the frontend is on another host, so we need the backend URL.
const base = import.meta.env.DEV ? '' : (import.meta.env.VITE_BACKEND_URL ?? '');

export const apiUrl = (path: string): string => `${base.replace(/\/$/, '')}${path}`;