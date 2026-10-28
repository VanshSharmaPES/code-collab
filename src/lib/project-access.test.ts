import assert from "node:assert/strict";
import { test } from "node:test";
import { managerSql, participantSql } from "./project-access";

test("participants are the mentor, a team lead or a team member of the project, and the viewer is always a bound parameter", () => {
  const sql = participantSql("$5", "r.project_id");
  assert.match(sql, /px\.mentor_id = \$5::bigint/);
  assert.match(sql, /tx\.lead_id = \$5::bigint/);
  assert.match(sql, /tmx\.user_id = \$5::bigint/);
  assert.match(sql, /px\.id = r\.project_id/);
  assert.doesNotMatch(sql, /\bOR TRUE\b|1 = 1|IS NULL/); // no bypass such as "no viewer means everyone"
});

test("managers are only the mentor or a team lead, never a plain member", () => {
  const sql = managerSql("$4", "r.project_id");
  assert.match(sql, /px\.mentor_id = \$4::bigint/);
  assert.match(sql, /tx\.lead_id = \$4::bigint/);
  assert.doesNotMatch(sql, /team_members|tmx/);
});

test("only a parameter placeholder and a table.column name can be put into the fragments", () => {
  for (const bad of ["5", "$0", "$", "$5; DROP TABLE users", "$5::bigint", "'1'", "$100", "$5 OR 1=1"]) assert.throws(() => participantSql(bad, "r.project_id"), TypeError, bad);
  for (const bad of ["project_id", "r.project_id OR 1=1", "r.project_id)", "R.project_id", "r.", "1.id"]) assert.throws(() => managerSql("$1", bad), TypeError, bad);
});
