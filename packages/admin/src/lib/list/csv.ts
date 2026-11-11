/** CSV text (RFC 4180) from a header and rows; objects are written as JSON. */
export function toCsv(header: string[], rows: unknown[][]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    // A leading =, +, - or @ would run as a formula when the file is opened in a spreadsheet.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}
