/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RT_MODE?: 'public' | 'local';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
