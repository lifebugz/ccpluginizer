// The pipeline-wide walk/parse cache contract: one memoized lister, one memoized
// frontmatter reader, and the permission-skip channel — owned here (above fsWalk /
// frontmatterIo, below every detector) so neither the sniffer nor the layout
// resolver has to define the shape the whole scan shares.

import { makeDirLister, type DirLister } from "./fsWalk.ts";
import { makeFrontmatterReader, type FrontmatterReader } from "./frontmatterIo.ts";

export interface ScanCaches {
  readonly list?: DirLister;
  readonly readFrontmatter?: FrontmatterReader;
  /** Paths skipped for permission errors — shared by reference across follow-up runs. */
  readonly skippedPaths?: string[];
}

/** A fully-wired cache set whose lister and reader report permission skips. */
export function makeScanCaches(): Required<ScanCaches> {
  const skippedPaths: string[] = [];
  const onSkip = (p: string): void => {
    skippedPaths.push(p);
  };
  return {
    list: makeDirLister(onSkip),
    readFrontmatter: makeFrontmatterReader(onSkip),
    skippedPaths,
  };
}
