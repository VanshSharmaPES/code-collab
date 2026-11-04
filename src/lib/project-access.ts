// Who may see and act on a project's rows. Pure SQL builders, shared by the issue and pull request queries.
//
// The rule (least privilege; docs/on_delete.md documents that a project is visible to its mentor, and the merge procedure
// (P1-09) already lets only a team lead or the mentor merge; the rest is the same reading applied to every query):
//   * a participant of a project is its mentor, the lead of one of its teams, or a member of one of its teams;
//   * only participants can see the project's issues, pull requests and repositories, and write to them;
//   * a manager is the mentor or a team lead; a pull request can be closed or reopened by its author or a manager.
// The viewer is always the signed-in user from the session. Nothing here takes a value from a request: the pieces
// are SQL fragments built from a parameter placeholder ($n) and a column name, both checked.

const PLACEHOLDER = /^\$[1-9]\d?$/;
const COLUMN = /^[a-z]{1,12}\.[a-z_]{1,24}$/;

function checked(viewer: string, projectId: string): void {
  if (!PLACEHOLDER.test(viewer)) throw new TypeError("The viewer must be a parameter placeholder such as $5.");
  if (!COLUMN.test(projectId)) throw new TypeError("The project must be a table.column name such as r.project_id.");
  // The fragments use the aliases px, tx and tmx. A column on one of them would be read from the inner table, so the
  // check would compare a row with itself and let the viewer see every project.
  if (/^(px|tx|tmx)\./.test(projectId)) throw new TypeError("The project column cannot use the aliases px, tx or tmx.");
}

// The viewer is the mentor, a team lead, or a team member of the project in `projectId`.
export function participantSql(viewer: string, projectId: string): string {
  checked(viewer, projectId);
  const v = `${viewer}::bigint`;
  return (
    `(EXISTS (SELECT 1 FROM projects px WHERE px.id = ${projectId} AND px.mentor_id = ${v}) ` +
    `OR EXISTS (SELECT 1 FROM teams tx WHERE tx.project_id = ${projectId} AND (tx.lead_id = ${v} OR ` +
    `EXISTS (SELECT 1 FROM team_members tmx WHERE tmx.team_id = tx.id AND tmx.user_id = ${v}))))`
  );
}

// The viewer is the mentor or a team lead of the project.
export function managerSql(viewer: string, projectId: string): string {
  checked(viewer, projectId);
  const v = `${viewer}::bigint`;
  return (
    `(EXISTS (SELECT 1 FROM projects px WHERE px.id = ${projectId} AND px.mentor_id = ${v}) ` +
    `OR EXISTS (SELECT 1 FROM teams tx WHERE tx.project_id = ${projectId} AND tx.lead_id = ${v}))`
  );
}
