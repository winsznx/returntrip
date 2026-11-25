export const WORKSPACE_NAME_MAX_LENGTH = 80;
const SLUG_MAX_LENGTH = 64;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMBINING_MARKS = /[̀-ͯ]/g;
const CONTROL_CHARACTERS = /\p{Cc}/u;

export interface Workspace {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface WorkspaceSummary extends Workspace {
  readonly recordCount: number;
}

export type WorkspaceDraft =
  | { readonly ok: true; readonly name: string; readonly slug: string }
  | { readonly ok: false; readonly error: string };

export function isValidSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}

/** "Café Núñez Payments" becomes "cafe-nunez-payments". */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, '');
}

export function draftWorkspace(rawName: string): WorkspaceDraft {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (name === '') {
    return { ok: false, error: 'Enter a workspace name.' };
  }
  if ([...name].length > WORKSPACE_NAME_MAX_LENGTH) {
    return { ok: false, error: `Workspace names can be at most ${WORKSPACE_NAME_MAX_LENGTH} characters.` };
  }
  if (CONTROL_CHARACTERS.test(name)) {
    return { ok: false, error: 'Workspace names cannot contain control characters.' };
  }
  const slug = slugify(name);
  if (slug === '') {
    return { ok: false, error: 'Workspace names need at least one letter or number.' };
  }
  return { ok: true, name, slug };
}
