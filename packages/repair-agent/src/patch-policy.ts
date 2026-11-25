import type { PatchRejectionCode, PatchValidation } from '@returntrip/contracts';
import { changedLinesAgainst, diffAgainst, rawChangesAgainst, sha256 } from '@returntrip/target-runtime';

export interface PatchPolicy {
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly maxChangedFiles: number;
  readonly maxChangedLines: number;
  readonly previousPatchHashes: readonly string[];
}

export interface ValidatedPatch {
  readonly validation: PatchValidation;
  readonly patch: string;
}

const SYMLINK_MODE = '120000';
const SUBMODULE_MODE = '160000';
const ABSENT_MODE = '000000';

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Segment-aware prefix match, so `src/import` allows `src/import/x.ts` but not `src/importer.ts`. */
export function isUnder(path: string, root: string): boolean {
  const file = normalize(path);
  const dir = normalize(root);
  return file === dir || file.startsWith(`${dir}/`);
}

export function countChangedLines(patch: string): number {
  let lines = 0;
  for (const line of patch.split('\n')) {
    if (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    ) {
      lines += 1;
    }
  }
  return lines;
}

function reject(
  code: PatchRejectionCode,
  detail: string,
  files: readonly string[],
  patch: string,
): ValidatedPatch {
  return {
    patch,
    validation: {
      ok: false,
      sha256: patch ? sha256(patch) : null,
      files,
      linesChanged: countChangedLines(patch),
      rejection: { code, detail },
    },
  };
}

/**
 * Checks what the agent actually changed on disk, from git's own view of the tree, against the
 * repair scope. Path checks use git's paths, never the agent's description of what it did.
 */
export async function validatePatch(
  dir: string,
  baseTree: string,
  policy: PatchPolicy,
): Promise<ValidatedPatch> {
  const changes = await rawChangesAgainst(dir, baseTree);
  const patch = await diffAgainst(dir, baseTree);
  const files = changes.map((change) => change.path).sort();

  if (changes.length === 0 || patch.trim() === '')
    return reject('EMPTY', 'the agent made no changes', files, patch);

  for (const change of changes) {
    const path = normalize(change.path);
    if (path.startsWith('/') || path.split('/').includes('..') || path.startsWith('.git/')) {
      return reject('OUTSIDE_ALLOWED_PATHS', `unsafe path ${path}`, files, patch);
    }
    const protectedRoot = policy.protectedPaths.find((root) => isUnder(path, root));
    if (protectedRoot)
      return reject('PROTECTED_PATH', `${path} is protected (${protectedRoot})`, files, patch);
    if (!policy.allowedPaths.some((root) => isUnder(path, root))) {
      return reject(
        'OUTSIDE_ALLOWED_PATHS',
        `${path} is outside ${policy.allowedPaths.join(', ')}`,
        files,
        patch,
      );
    }
    if (change.newMode === SYMLINK_MODE || change.oldMode === SYMLINK_MODE) {
      return reject('SYMLINK', `${path} is a symlink change`, files, patch);
    }
    if (change.newMode === SUBMODULE_MODE || change.oldMode === SUBMODULE_MODE) {
      return reject('OUTSIDE_ALLOWED_PATHS', `${path} is a submodule change`, files, patch);
    }
    if (
      change.oldMode !== ABSENT_MODE &&
      change.newMode !== ABSENT_MODE &&
      change.oldMode !== change.newMode
    ) {
      return reject(
        'MODE_CHANGE',
        `${path} changed mode ${change.oldMode} -> ${change.newMode}`,
        files,
        patch,
      );
    }
  }
  const counted = await changedLinesAgainst(dir, baseTree);
  if (counted.binary || /^GIT binary patch$|^Binary files /m.test(patch))
    return reject('BINARY', 'binary changes are not allowed', files, patch);
  if (files.length > policy.maxChangedFiles) {
    return reject(
      'TOO_LARGE',
      `${files.length} files changed, limit ${policy.maxChangedFiles}`,
      files,
      patch,
    );
  }
  const linesChanged = counted.lines;
  if (linesChanged > policy.maxChangedLines) {
    return reject(
      'TOO_LARGE',
      `${linesChanged} lines changed, limit ${policy.maxChangedLines}`,
      files,
      patch,
    );
  }
  const hash = sha256(patch);
  if (policy.previousPatchHashes.includes(hash)) {
    return reject(
      'DUPLICATE_OF_PREVIOUS',
      'identical to a patch that already failed verification',
      files,
      patch,
    );
  }
  return { patch, validation: { ok: true, sha256: hash, files, linesChanged, rejection: null } };
}
