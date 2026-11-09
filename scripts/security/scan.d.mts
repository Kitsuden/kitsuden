type Platform = "linux-x64" | "darwin-arm64" | "win32-x64";

export interface PinnedTool {
  version: string;
  url(version: string, asset: string): string;
  assets: Record<Platform, [asset: string, sha256: string]>;
}

export interface OsvFinding {
  pkg: string;
  ids: string[];
  score: number;
}

export const CHECKOV: string;
export const TOOLS: Record<"gitleaks" | "osv-scanner" | "trivy", PinnedTool>;
export function tool(name: keyof typeof TOOLS): Promise<string>;
export function groupScore(group: { max_severity?: string } | undefined): number;
export function triageOsv(report: unknown): { blocking: OsvFinding[]; other: OsvFinding[] };
