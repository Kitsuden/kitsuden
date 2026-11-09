export const AIG_MCP_SCAN: string;
export const AIG_SKILL_SCAN: string;
export const MCP_CODE: string[];
export function argsObject(argv: string[]): {
  targets: string[];
  prescanOnly: boolean;
  help?: boolean;
};
export function validTestUrl(text: string): string | null;
