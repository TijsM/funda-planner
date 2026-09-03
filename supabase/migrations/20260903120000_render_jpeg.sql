-- Google's Interactions API answers JPEG and nothing else.
--
-- Probed against the live endpoint on 2026-09-03:
--   "The value 'image/png' is not supported for 'response_format.mime_type'.
--    Supported values: 'image/jpeg'."
--
-- The bucket was created allowing image/png alone, back when every provider drew
-- a PNG. A render that arrives as a JPEG is refused at upload with a message
-- about mime types, AFTER the credit has been spent — so the allowlist grows by
-- exactly one entry. The 20 MB size limit is unchanged, and nothing about the
-- RLS policies (which authorise on the first path segment) is touched.
update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg']
 where id = 'renders';
