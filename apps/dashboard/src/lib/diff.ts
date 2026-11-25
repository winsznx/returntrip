export type DiffLineType = 'context' | 'add' | 'remove' | 'note';

export interface DiffLine {
  /** Position in the whole diff, a stable render key. */
  readonly id: number;
  readonly type: DiffLineType;
  readonly text: string;
  readonly oldNumber: number | null;
  readonly newNumber: number | null;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly hunks: readonly DiffHunk[];
  readonly additions: number;
  readonly deletions: number;
}

interface MutableFile {
  oldPath: string | null;
  newPath: string | null;
  hunks: { header: string; lines: DiffLine[] }[];
  additions: number;
  deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function headerPath(raw: string): string | null {
  const path = raw.split('\t')[0]?.trim() ?? '';
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

/**
 * Parses a unified diff (git or plain) into files and hunks with line numbers. Hunk bodies are
 * read by their declared line counts, so a removed line that starts with "--" is never taken for
 * a file header. Lines outside hunks other than headers (index, mode) are skipped.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: MutableFile[] = [];
  let file: MutableFile | null = null;
  let lines: DiffLine[] | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let nextId = 0;

  const startFile = (oldPath: string | null, newPath: string | null): MutableFile => {
    const created: MutableFile = { oldPath, newPath, hunks: [], additions: 0, deletions: 0 };
    files.push(created);
    return created;
  };

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const inHunk = lines !== null && (oldLeft > 0 || newLeft > 0);
    if (inHunk && lines && file) {
      if (line.startsWith('+')) {
        lines.push({ id: nextId++, type: 'add', text: line.slice(1), oldNumber: null, newNumber: newLine++ });
        file.additions++;
        newLeft--;
      } else if (line.startsWith('-')) {
        lines.push({
          id: nextId++,
          type: 'remove',
          text: line.slice(1),
          oldNumber: oldLine++,
          newNumber: null,
        });
        file.deletions++;
        oldLeft--;
      } else if (line.startsWith('\\')) {
        lines.push({ id: nextId++, type: 'note', text: line, oldNumber: null, newNumber: null });
      } else {
        lines.push({
          id: nextId++,
          type: 'context',
          text: line.slice(1),
          oldNumber: oldLine++,
          newNumber: newLine++,
        });
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith('\\') && lines) {
      lines.push({ id: nextId++, type: 'note', text: line, oldNumber: null, newNumber: null });
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      file = startFile(match?.[1] ?? null, match?.[2] ?? null);
      lines = null;
    } else if (line.startsWith('--- ')) {
      const oldPath = headerPath(line.slice(4));
      if (!file || file.hunks.length > 0) file = startFile(oldPath, null);
      else file.oldPath = oldPath;
      lines = null;
    } else if (line.startsWith('+++ ') && file) {
      file.newPath = headerPath(line.slice(4));
    } else {
      const header = HUNK_HEADER.exec(line);
      if (!header) continue;
      if (!file) file = startFile(null, null);
      oldLine = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      lines = [];
      file.hunks.push({ header: line, lines });
    }
  }
  return files;
}

export function displayPath(file: DiffFile): string {
  if (file.oldPath && file.newPath && file.oldPath !== file.newPath)
    return `${file.oldPath} to ${file.newPath}`;
  return file.newPath ?? file.oldPath ?? 'unnamed file';
}
