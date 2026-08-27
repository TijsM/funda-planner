-- Plattegrond Studio — object photographs.
--
-- The pictures of real furniture a person attaches to objects on a plan, so the
-- render draws the sofa they actually bought. Inputs, not outputs: the owner
-- replaces them freely, and nothing here costs a credit to produce.
--
-- NO TABLE, deliberately. A render needs a row because it has a status, a prompt
-- and a polling URL that must outlive the tab. A photo has none of that: its
-- name, size, note and priority are a `PhotoRef` inside `plans.doc`, which
-- already syncs and already participates in undo. A row would be a second copy
-- of facts the document owns, and two copies of a fact is one of them being
-- wrong. What is left is bytes, which is what a bucket is for.
--
-- Apply with:  supabase db push        (or paste into the SQL editor)
--
-- Every statement is guarded, so applying this twice is a no-op rather than an
-- error. That is not tidiness: the bucket and the policies are separate
-- statements, and a run that creates the bucket and then fails on a policy has
-- to be safe to run again.

-- ─────────────────────────────────────────────────────────────────────────────
-- storage — the photo JPEGs.
--
-- Private bucket. Keys are `<owner uuid>/<plan client id>/<photo id>.jpg`, and
-- the four policies below authorise on the FIRST path segment alone, exactly as
-- the renders bucket does — so a signed URL is the only way bytes ever leave.
-- The plan segment is not a permission boundary; it is what makes deleting one
-- plan's photos a prefix listing instead of a query.
--
-- 10 MB, and JPEG only, because that is all the app ever writes: every photo is
-- re-encoded in the browser to a 1024 px JPEG before it is uploaded (see
-- `encodePhoto` in src/shell/photos.ts), which lands at a couple of hundred
-- kilobytes. The limit is not sized for what a phone produces — it is sized so
-- that anything much larger than what we produce is refused by the bucket rather
-- than discovered in a bill.
-- ─────────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 10485760, array['image/jpeg'])
on conflict (id) do nothing;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'photo objects are readable by their owner') then
    create policy "photo objects are readable by their owner"
      on storage.objects for select
      using (
        bucket_id = 'photos'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'photo objects are insertable by their owner') then
    create policy "photo objects are insertable by their owner"
      on storage.objects for insert
      with check (
        bucket_id = 'photos'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end $$;

-- Updatable as well as insertable: `upload(..., { upsert: true })` is an update
-- when the key already exists, and re-attaching after a failed write has to
-- overwrite rather than 409. The id is minted by us, so a collision can only
-- ever be the same picture.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'photo objects are updatable by their owner') then
    create policy "photo objects are updatable by their owner"
      on storage.objects for update
      using (
        bucket_id = 'photos'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'photo objects are deletable by their owner') then
    create policy "photo objects are deletable by their owner"
      on storage.objects for delete
      using (
        bucket_id = 'photos'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end $$;
