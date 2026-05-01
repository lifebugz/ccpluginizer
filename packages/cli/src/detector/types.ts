export type Confidence = "high" | "medium" | "low";

export type ComponentKind =
  | "skills"
  | "agents"
  | "commands"
  | "hooks"
  | "mcpServers"
  | "outputStyles"
  | "themes"
  | "monitors";

export interface Finding {
  readonly kind: ComponentKind;
  readonly paths: readonly string[];
  readonly confidence: Confidence;
  readonly source: "marker" | "convention" | "manifest" | "sniff";
}

export interface DetectionResult {
  readonly findings: readonly Finding[];
  readonly metadata: DetectedMetadata;
}

export interface DetectedMetadata {
  readonly name?: string;
  readonly description?: string;
  readonly license?: string;
  readonly author?: string | { readonly name: string };
  readonly homepage?: string;
  readonly repository?: string;
}
