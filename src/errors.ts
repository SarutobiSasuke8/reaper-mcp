// Adapted from the house MCP template errors.ts (MIT); see THIRD_PARTY.md.
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}
