-- Run once in the Supabase SQL editor. Audio is no longer stored in the database,
-- so these tables are unused. Dropping them returns all of their space immediately.
DROP TABLE IF EXISTS audio_chunks;
DROP TABLE IF EXISTS audio_cache;

-- Optional: see how big your remaining tables are.
SELECT relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
