/** Error codes an agent can branch on. Every tool failure carries one. */
export type ErrorCode =
  | 'FCPTOOL_NOT_FOUND'   // Final Cut Pro 13 / fcptool is not installed where we looked
  | 'LIBRARY_LOCKED'      // library is open in Final Cut Pro or another process holds its lock
  | 'NOT_FOUND'           // path, library or event does not exist
  | 'ALREADY_EXISTS'      // target path is already occupied
  | 'INVALID_ARGUMENT'    // a value fcptool (or this server) rejected
  | 'NEEDS_UPGRADE'       // library catalog is older than this Final Cut Pro; pass autoUpgrade: true
  | 'VALIDATION_FAILED'   // FCPXML does not conform to its DTD
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'FCPTOOL_ERROR';      // any other non-zero exit from fcptool

export class ToolError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}), ...(this.details ? { details: this.details } : {}) };
  }
}

/** Maps fcptool's plain-text "Error: ..." output (it never emits JSON errors) to a code + hint. */
export function classifyFcptoolError(text: string): { code: ErrorCode; message: string; hint?: string } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const errLine = lines.find((l) => l.startsWith('Error:')) ?? lines.at(-1) ?? 'fcptool failed with no output';
  const message = errLine.replace(/^Error:\s*/, '');
  const t = text;
  if (/Library permissions error/i.test(t))
    return { code: 'LIBRARY_LOCKED', message, hint: 'The library is open in Final Cut Pro (or another process). Close it in Final Cut Pro (File > Close Library) and retry. Read-only "library info" still works on open libraries.' };
  if (/Unsupported library location open/i.test(t))
    return { code: 'ALREADY_EXISTS', message, hint: 'Something already exists at that path. Choose a new path for the library.' };
  if (/no such file|was not found|does not exist|couldn.t be opened/i.test(t))
    return { code: 'NOT_FOUND', message };
  if (/not a FCP library/i.test(t))
    return { code: 'INVALID_ARGUMENT', message, hint: 'The path exists but is not a Final Cut Pro library (.fcpbundle).' };
  if (/update|upgrade/i.test(t) && /catalog|version|library/i.test(t) && !/Invalid/i.test(t))
    return { code: 'NEEDS_UPGRADE', message, hint: 'Retry with autoUpgrade: true, or run fcp_library_upgrade first. Upgraded libraries cannot be opened by older Final Cut Pro versions.' };
  if (/Invalid|Valid values|Missing expected argument|Unknown option|Unexpected argument|must be/i.test(t))
    return { code: 'INVALID_ARGUMENT', message };
  return { code: 'FCPTOOL_ERROR', message };
}
