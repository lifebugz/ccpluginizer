export class CcpluginizerError extends Error {
  public override readonly name: string = "CcpluginizerError";
}

export class AlreadyMarketplaceError extends CcpluginizerError {
  public override readonly name = "AlreadyMarketplaceError";
  public constructor(public readonly repoPath: string) {
    super(
      "This repo is already a marketplace; install via `/plugin marketplace add <repo>` directly. ccpluginizer is for non-plugin repos only.",
    );
  }
}

export class MarkerFileError extends CcpluginizerError {
  public override readonly name = "MarkerFileError";
  public constructor(
    message: string,
    public readonly issues: readonly unknown[],
  ) {
    super(message);
  }
}

export class PathNormalizationError extends CcpluginizerError {
  public override readonly name = "PathNormalizationError";
  public constructor(public readonly invalidPath: string, reason: string) {
    super(`Path "${invalidPath}" is invalid: ${reason}`);
  }
}

export class SourceCloneError extends CcpluginizerError {
  public override readonly name = "SourceCloneError";
  public constructor(public readonly source: string, cause: string) {
    super(`Failed to fetch source "${source}": ${cause}`);
  }
}
