-- 0015_photo_framing.sql (PR #26 review, Payam 2026-10-17): how a progress photo is framed, detected on the phone by
-- the guide camera's pose check: 'full' (head and feet in the frame, someone else takes it) or 'upper' (head to waist,
-- in a mirror with the phone in hand). NULL for photos from the library and every photo taken before this column;
-- Before · After pairs only photos of the same pose and the same framing (NULL pairs only with NULL).
ALTER TABLE photos ADD COLUMN framing TEXT CHECK (framing IS NULL OR framing IN ('full', 'upper'));
