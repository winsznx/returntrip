export { sha256 } from './hash.ts';
export { allocatePort, type RunningTarget, runStep, startTarget, waitForHealth } from './lifecycle.ts';
export { fillArgv, fillPlaceholders, type PlaceholderValues, placeholdersIn } from './placeholders.ts';
export { type ExecOptions, type ExecResult, execArgv, killTree, minimalEnv } from './process.ts';
export {
  applyPatch,
  changedLinesAgainst,
  diffAgainst,
  gitDirFor,
  gitInCopy,
  hashTree,
  prepareTargetCopy,
  rawChangesAgainst,
  removeTargetCopy,
  restoreTree,
  snapshotTree,
  type TargetCopy,
} from './workspace.ts';
