export type SourceInput =
  | { readonly kind: "github"; readonly repo: string }
  | { readonly kind: "local"; readonly path: string };

export function parseSourceInput(input: string): SourceInput {
  const trimmed = input.trim();

  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return { kind: "local", path: trimmed };
  }

  const httpsMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (httpsMatch?.[1] !== undefined) {
    return { kind: "github", repo: httpsMatch[1] };
  }

  const sshMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch?.[1] !== undefined) {
    return { kind: "github", repo: sshMatch[1] };
  }

  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return { kind: "github", repo: trimmed };
  }

  throw new Error(`Cannot parse source input: ${trimmed}`);
}
