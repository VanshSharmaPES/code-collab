-- Q4a: histogram of contribution scores across all members, eight equal-width buckets.
-- width_bucket() assigns each score to a bucket. generate_series() supplies all eight
-- buckets, so an empty range still appears as a row with 0 members instead of vanishing
-- from the chart. The bar column is a quick text chart.
WITH scores AS (
    SELECT score FROM member_contribution_v
), bounds AS (
    SELECT min(score) AS lo, max(score) + 0.01 AS hi FROM scores
), counted AS (
    SELECT width_bucket(s.score, b.lo, b.hi, 8) AS bucket, count(*) AS members
      FROM scores s CROSS JOIN bounds b
     GROUP BY 1
)
SELECT g.bucket,
       round(b.lo + (g.bucket - 1) * (b.hi - b.lo) / 8, 0) AS from_score,
       round(b.lo +  g.bucket      * (b.hi - b.lo) / 8, 0) AS to_score,
       coalesce(c.members, 0)                               AS members,
       repeat('#', coalesce(c.members, 0)::int)             AS bar
FROM generate_series(1, 8) AS g(bucket)
CROSS JOIN bounds b
LEFT JOIN counted c USING (bucket)
ORDER BY g.bucket;

-- Q4b: summary statistics for the same scores. percentile_cont() interpolates, so the
-- median and quartiles are exact even with an even number of members.
SELECT count(*)                                                       AS members,
       min(score)                                                     AS min,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY score)::numeric(10,1) AS p25,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY score)::numeric(10,1) AS median,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY score)::numeric(10,1) AS p75,
       percentile_cont(0.90) WITHIN GROUP (ORDER BY score)::numeric(10,1) AS p90,
       max(score)                                                     AS max,
       round(avg(score), 1)                                           AS mean,
       round(stddev_pop(score), 1)                                    AS stddev
FROM member_contribution_v;
