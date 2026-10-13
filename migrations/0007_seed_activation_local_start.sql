-- 0007_seed_activation_local_start.sql: the seed program's activation started at 2026-09-27T00:00:00Z, which is
-- 6 pm on Sep 26 in Denver (the app's time zone), so the app showed "since Sep 26". Payam started the program on
-- Sep 27: move the start to local midnight of Sep 27 (06:00 UTC, MDT). Only the untouched seed row changes.
UPDATE program_activations SET started_at = '2026-09-27T06:00:00.000Z'
WHERE id = 'act-fullbody4-seed' AND started_at = '2026-09-27T00:00:00.000Z';
