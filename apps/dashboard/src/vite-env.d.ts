/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RT_MODE?: 'public' | 'local';
  readonly VITE_RETURNTRIP_REPO_URL?: string;
  readonly VITE_RETURNTRIP_DEMO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
