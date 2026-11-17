export type PaperSource = { path: string; text: string };
export type PaperCorpus = {
  files: PaperSource[];
  skipped: { path: string; reason: string }[];
  complete: boolean;
};
export type PaperTool = 'references' | 'table' | 'preflight';
