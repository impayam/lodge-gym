// Body measurements (SPEC-v12 M15 §4): sizes in cm logged any time, any subset of eight fields per entry. Pure: the
// latest value of each field and its change since the previous entry that has it.

export const SIZE_FIELDS = ["arm", "chest", "shoulders", "waist", "hips", "thigh", "calf", "neck"] as const;
export type SizeField = (typeof SIZE_FIELDS)[number];

export const SIZE_NAME: Readonly<Record<SizeField, string>> = {
  arm: "Arm",
  chest: "Chest",
  shoulders: "Shoulders",
  waist: "Waist",
  hips: "Hips",
  thigh: "Thigh",
  calf: "Calf",
  neck: "Neck",
};

export interface BodyMeasurement {
  id: string;
  local_date: string;
  arm_cm: number | null;
  chest_cm: number | null;
  waist_cm: number | null;
  hips_cm: number | null;
  thigh_cm: number | null;
  calf_cm: number | null;
  neck_cm: number | null;
  shoulders_cm: number | null;
  note: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export const sizeKey = (f: SizeField) => `${f}_cm` as const;
export const sizeOf = (m: BodyMeasurement, f: SizeField): number | null => m[sizeKey(f)];

const round1 = (n: number) => Math.round(n * 10) / 10;
const order = (a: BodyMeasurement, b: BodyMeasurement) => (a.local_date + a.created_at).localeCompare(b.local_date + b.created_at);

export interface LatestSize {
  field: SizeField;
  value: number;
  date: string;
  /** Change since the previous entry that has this field; null when there is none. */
  change: number | null;
  /** Date of that previous entry. */
  since: string | null;
}

/** The latest value of every field that was ever logged, in SIZE_FIELDS order, deleted entries left out. */
export function latestSizes(list: readonly BodyMeasurement[]): LatestSize[] {
  const live = list.filter((m) => !m.deleted_at).sort(order);
  return SIZE_FIELDS.flatMap((f) => {
    const has = live.filter((m) => sizeOf(m, f) != null);
    if (!has.length) return [];
    const last = has[has.length - 1];
    const prev = has.length > 1 ? has[has.length - 2] : null;
    const value = sizeOf(last, f)!;
    return [{ field: f, value, date: last.local_date, change: prev ? round1(value - sizeOf(prev, f)!) : null, since: prev?.local_date ?? null }];
  });
}

/** Change of a field over [from, to]: the last value up to `to` minus the first value from `from`; null without two. */
export function sizeChange(list: readonly BodyMeasurement[], f: SizeField, from: string, to: string): number | null {
  const has = list.filter((m) => !m.deleted_at && sizeOf(m, f) != null && m.local_date >= from && m.local_date <= to).sort(order);
  if (has.length < 2) return null;
  return round1(sizeOf(has[has.length - 1], f)! - sizeOf(has[0], f)!);
}
