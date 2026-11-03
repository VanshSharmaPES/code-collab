-- Q1: top three contributors per project, ranked by contribution score.
-- Window functions: RANK() orders members inside each project, SUM() OVER gives the
-- project total so each person's share can be shown. Ties share a rank.
SELECT project_id,
       project_name,
       rank,
       user_id,
       full_name,
       score,
       round(100 * score / nullif(project_total, 0), 1) AS pct_of_project
FROM (
    SELECT m.*,
           RANK()  OVER (PARTITION BY m.project_id ORDER BY m.score DESC) AS rank,
           SUM(m.score) OVER (PARTITION BY m.project_id)                  AS project_total
    FROM member_contribution_v m
) ranked
WHERE rank <= 3
ORDER BY project_id, rank, user_id;
