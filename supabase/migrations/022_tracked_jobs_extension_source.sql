-- Migration: 022_tracked_jobs_extension_source
-- Allows tracked jobs saved from the Unviewable browser extension.
--
-- The extension saves the posting on the user's current tab (LinkedIn, Naukri,
-- Internshala, company career pages, ...) straight into the tracker. Those rows
-- are neither hand-typed ('manual') nor from a polled ATS board, and labelling
-- them 'manual' would lose the one signal that tells us whether the extension is
-- being used at all.
--
-- `external_id` for these rows is a normalised form of the posting URL (host +
-- path, or the site's own job id where the URL carries one), so the existing
-- partial unique index on (user_id, source, external_id) turns a second save of
-- the same posting into a 409 `duplicate_job` rather than a duplicate row.
--
-- The route (src/app/api/jobs/route.ts) whitelists the same values, so keep the
-- two lists in step.

alter table public.tracked_jobs
  drop constraint if exists tracked_jobs_source_check;

alter table public.tracked_jobs
  add constraint tracked_jobs_source_check
  check (source in ('manual', 'extension', 'greenhouse', 'lever', 'ashby', 'adzuna'));

-- VERIFY
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'tracked_jobs_source_check';
--   -- expect the list above, including 'extension'
