export type AppMode = 'local' | 'public';

/** Fixed at build time: `build` makes the local dashboard, `build:public` the recorded-run site. */
export const MODE: AppMode = import.meta.env.VITE_RT_MODE === 'public' ? 'public' : 'local';
