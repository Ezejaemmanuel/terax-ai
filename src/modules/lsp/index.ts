// The editor extension is deliberately absent here: it is imported lazily so a
// window that never enables a project never loads it.
export { isLspCandidate, languageIdForPath } from "./paths";
export {
  lspEnablement,
  lspRootForPath,
  normalizeRoot,
  recordFileProblems,
  rootForPathIn,
  useLspStore,
  type LspEnablement,
} from "./store";
export { LspToggle } from "./LspToggle";
export { ProblemsPanel } from "./ProblemsPanel";
