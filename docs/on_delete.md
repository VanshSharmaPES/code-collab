# ON DELETE policy (P1-08)

Every foreign key was assigned one of three behaviours using four rules.

| Rule | Applies when | Action |
|---|---|---|
| Containment | the child has no meaning without the parent | CASCADE |
| Attribution | the child records who did something; history outlives the person | SET NULL |
| Accountability | the parent holds a responsibility that must be handed over first | RESTRICT |
| Derived data | the row can be rebuilt from other tables | CASCADE |

Users are never meant to be hard-deleted by the application. Accounts are deactivated, which is a future enhancement (an `is_active` column). The rules below govern what happens if a deletion does occur, for example during administration or tests.

| # | Foreign key | Parent | On delete | Why |
|---|---|---|---|---|
| 1 | projects.mentor_id | users | **RESTRICT** | A project without a mentor is invisible to every mentor under role-based access. The mentor must be reassigned before they can be removed. |
| 2 | projects.created_by | users | SET NULL | Records who created the project. The project outlives its creator. |
| 3 | teams.project_id | projects | CASCADE | A team exists only inside its project. |
| 4 | teams.lead_id | users | SET NULL | The team continues. A mentor appoints a new lead. |
| 5 | team_members.team_id | teams | CASCADE | Membership has no meaning without the team. |
| 6 | team_members.user_id | users | CASCADE | Membership has no meaning without the user. |
| 7 | repositories.project_id | projects | CASCADE | A repository belongs to exactly one project. |
| 8 | commits.repository_id | repositories | CASCADE | A commit belongs to its repository's history. |
| 9 | commits.author_id | users | SET NULL | History is kept. `author_name` and `author_email` stay on the row, so attribution survives. |
| 10 | issues.repository_id | repositories | CASCADE | Issues belong to one repository. |
| 11 | issues.author_id | users | SET NULL | The issue and its discussion matter more than who opened it. |
| 12 | issues.assignee_id | users | SET NULL | The issue becomes unassigned and remains open. |
| 13 | pull_requests.repository_id | repositories | CASCADE | Pull requests belong to one repository. |
| 14 | pull_requests.author_id | users | SET NULL | The change record outlives its author. |
| 15 | pull_requests.merged_by | users | SET NULL | The merge is also recorded in `audit_log`, so accountability is not lost. A "merged requires merged_by" CHECK was deliberately not added, because it would contradict this rule. |
| 16 | pr_reviews.pull_request_id | pull_requests | CASCADE | A review is meaningless without its pull request. |
| 17 | pr_reviews.reviewer_id | users | SET NULL | The review verdict stays. UNIQUE treats NULLs as distinct, so this is safe. |
| 18 | pr_issue_links.pull_request_id | pull_requests | CASCADE | Junction row. |
| 19 | pr_issue_links.issue_id | issues | CASCADE | Junction row. Deleting an issue unlinks it, and the pull request remains. |
| 20 | labels.project_id | projects | CASCADE | Labels are defined per project. |
| 21 | issue_labels.issue_id | issues | CASCADE | Junction row. |
| 22 | issue_labels.label_id | labels | CASCADE | Junction row. Deleting a label untags issues, and the issues remain. |
| 23 | audit_log.actor_id | users | SET NULL | An audit trail must survive the departure of the person it names. |
| 24 | contribution_metrics.project_id | projects | CASCADE | Derived data, rebuilt by the refresh procedure. |
| 25 | contribution_metrics.user_id | users | CASCADE | Derived data, rebuilt by the refresh procedure. |

`audit_log.entity_id` is deliberately not a foreign key. One column refers to four different tables, so the history survives the deletion of the row it describes.

Totals: 15 CASCADE (13 containment or junction, 2 derived data), 9 SET NULL, 1 RESTRICT.

Deleting a project cascades through teams, repositories, commits, issues, pull requests, reviews, links, labels and metrics. For normal use a project is archived (`status = 'archived'`), not deleted.
