// Validation for the issue create/edit forms. Pure: no database, no framework imports.
export const ISSUE_STATUSES = ["open", "in_progress", "closed"] as const;
export const ISSUE_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const MAX_TITLE_LENGTH = 300;
export const MAX_BODY_LENGTH = 20_000;

export type IssueInput = { title: string; body: string | null; status: IssueStatus; priority: IssuePriority };
export type IssueFormValues = { repositoryId: string; title: string; body: string; status: string; priority: string };
export type IssueFormErrors = Partial<Record<keyof IssueFormValues, string>>;
export type IssueFormState = { values?: IssueFormValues; errors?: IssueFormErrors; message?: string };

export type ParsedIssueForm =
  | { ok: true; repositoryId: string | null; input: IssueInput }
  | { ok: false; values: IssueFormValues; errors: IssueFormErrors };

type FormLike = { get(name: string): unknown };

const field = (data: FormLike, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

// A database id as sent by a form: digits only, no leading zero, within bigint range.
export function parseId(value: string): string | null {
  return /^[1-9]\d{0,17}$/.test(value) ? value : null;
}

export function parseIssueForm(data: FormLike, options: { requireRepository: boolean }): ParsedIssueForm {
  const values: IssueFormValues = {
    repositoryId: field(data, "repositoryId"),
    title: field(data, "title"),
    body: field(data, "body"),
    status: field(data, "status") || "open",
    priority: field(data, "priority") || "medium",
  };
  const errors: IssueFormErrors = {};

  const title = values.title.trim();
  if (title === "") errors.title = "Enter a title.";
  else if (title.length > MAX_TITLE_LENGTH) errors.title = `The title must be at most ${MAX_TITLE_LENGTH} characters.`;
  else if (title.includes("\0") || /[\r\n]/.test(title)) errors.title = "The title must be a single line of text.";

  const body = values.body.replace(/\r\n?/g, "\n");
  if (body.length > MAX_BODY_LENGTH) errors.body = `The description must be at most ${MAX_BODY_LENGTH} characters.`;
  else if (body.includes("\0")) errors.body = "The description contains an invalid character.";

  if (!(ISSUE_STATUSES as readonly string[]).includes(values.status)) errors.status = "Choose a status.";
  if (!(ISSUE_PRIORITIES as readonly string[]).includes(values.priority)) errors.priority = "Choose a priority.";

  let repositoryId: string | null = null;
  if (options.requireRepository) {
    repositoryId = parseId(values.repositoryId);
    if (repositoryId === null) errors.repositoryId = "Choose a repository.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, values, errors };
  return {
    ok: true,
    repositoryId,
    input: {
      title,
      body: body.trim() === "" ? null : body,
      status: values.status as IssueStatus,
      priority: values.priority as IssuePriority,
    },
  };
}
