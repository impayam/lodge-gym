-- Reps in reserve per set (0, 1, 2, 3 = "3+"), optional.
ALTER TABLE set_entries ADD COLUMN rir INTEGER CHECK (rir IS NULL OR rir BETWEEN 0 AND 3);
