const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

export function formatDate(value: Date | string | null): string {
  return value === null ? "—" : dateFormat.format(new Date(value));
}

export function formatLabel(value: string): string {
  return value.replace(/_/g, " ");
}

// Reads a positive page number from a query string value; anything else is page 1.
export function parsePage(value: string | string[] | undefined): number {
  return typeof value === "string" && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : 1;
}
