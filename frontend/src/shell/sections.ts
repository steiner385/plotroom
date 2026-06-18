// The unified-workspace section model (spec 001, FR-001/FR-002). Five verb-named
// sections replace the four legacy tabs; each carries its "mode" (the default-vs-
// on-demand contract from the persona review). Pure — hash routing is testable
// without the DOM.

export type SectionId = 'health' | 'pipeline' | 'diagnose' | 'model' | 'optimize' | 'build' | 'tune';

export interface SectionDef {
  id: SectionId;
  label: string;
  /** the section's interaction mode (drives default-vs-on-demand disclosure) */
  mode: 'monitor' | 'drill' | 'read' | 'act' | 'configure';
  /** one-line purpose for tooltips/aria */
  blurb: string;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: 'health',   label: 'Health',              mode: 'monitor',   blurb: 'Is delivery healthy right now?' },
  { id: 'pipeline', label: 'Pipeline',            mode: 'monitor',   blurb: 'Every open PR and where it is in the pipeline.' },
  { id: 'diagnose', label: 'Diagnose',            mode: 'drill',     blurb: 'Why is this PR stuck?' },
  { id: 'model',    label: 'Model',               mode: 'read',      blurb: 'What gates a merge, and where is it drifting?' },
  { id: 'optimize', label: 'Optimize',            mode: 'act',       blurb: 'Findings → simulate → edit → draft PR.' },
  { id: 'build',    label: 'Build',               mode: 'act',       blurb: 'Shape the pipeline visually — compose changes, validate, draft PR.' },
  { id: 'tune',     label: 'Tune & Investigate',  mode: 'configure', blurb: 'Knobs, forecasts, history, outcomes.' },
];

export const DEFAULT_SECTION: SectionId = 'health';

const IDS = SECTIONS.map((s) => s.id) as readonly string[];

/** Parse a `#health` style hash into a SectionId (null if not a known section). */
export function sectionFromHash(hash: string): SectionId | null {
  const h = hash.replace(/^#/, '').trim().toLowerCase();
  return IDS.includes(h) ? (h as SectionId) : null;
}

/** The canonical hash for a section (for links + history). */
export function hashForSection(id: SectionId): string {
  return `#${id}`;
}

export function sectionDef(id: SectionId): SectionDef {
  return SECTIONS.find((s) => s.id === id)!;
}
