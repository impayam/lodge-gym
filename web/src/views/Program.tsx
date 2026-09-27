import { faNum } from "../../../worker/lib/digits";
import type { DayExercise } from "../../../worker/lib/types";
import { ytLink } from "../format";
import { exerciseMap } from "../model";
import { useStore } from "../store";

export function targetText(p: DayExercise) {
  if (p.is_time) return `${faNum(p.sets)} × ${faNum(p.reps_max)} ثانیه`;
  const reps = p.reps_min !== p.reps_max ? `${faNum(p.reps_min)}–${faNum(p.reps_max)}` : faNum(p.reps_max);
  return `${faNum(p.sets)} × ${reps}${p.per_leg ? " هر پا" : ""}`;
}

export function Program() {
  const boot = useStore((s) => s.boot)!;
  const exMap = exerciseMap(boot);
  return (
    <>
      <h2>قوانین برنامه</h2>
      <div class="card">
        <ul class="rules">
          <li>فول‌بادی با تمرکز روزانه: هر جلسه کل بدن را کار می‌دهد و حرکت اول، حرکت اصلی و سنگین آن روز است.</li>
          <li>ترتیب: روز ۱ ← ۲ ← ۳ ← ۴. هر روزی که رفتی، جلسه‌ی بعدی را بزن. بیشتر از دو روز پشت‌سرهم تمرین نکن.</li>
          <li>هدف: ۴ جلسه در ۷ روز.</li>
          <li>هفته‌ی ۱ و ۲: آخر هر ست ۳ تا ۴ تکرار ذخیره. از هفته‌ی ۳: ۱ تا ۲ تکرار ذخیره.</li>
          <li>همه‌ی ست‌ها کامل شد؟ جلسه‌ی بعد اضافه کن: بالاتنه ۵ پوند (۲٫۵ کیلو)، پایین‌تنه ۱۰ پوند (۵ کیلو)، دمبل ۵ پوند (۲ کیلو) برای هر دست.</li>
          <li>برای اینکه عضله از دست نرود: کالری کمتر از نیاز بدن نخور، ۱۳۰ تا ۱۵۰ گرم پروتئین در روز، ۷ تا ۹ ساعت خواب.</li>
          <li>A1/A2 و B1/B2 سوپرست‌اند: یکی در میان، بعد از هر دور ۶۰ تا ۹۰ ثانیه استراحت.</li>
          <li>هر ۶ تا ۸ هفته یک هفته‌ی سبک با نصف ست‌ها.</li>
        </ul>
      </div>
      {boot.program.days.map((d) => (
        <>
          <h2>
            {d.name_fa}{" "}
            <small class="ltr">{d.name_en}</small> <small>· حدود {faNum(d.est_minutes)} دقیقه</small>
          </h2>
          <div class="card prog-day">
            {d.exercises.map((p) => {
              const e = exMap.get(p.exercise_id)!;
              return (
                <div class="prog-item">
                  <div>
                    <b>
                      {p.is_main ? <span class="mainb">اصلی</span> : null}
                      {e.name_fa}
                      {p.superset_tag ? <span class="tag ltr">{p.superset_tag}</span> : null}
                    </b>
                    <small class="ltr" style={{ textAlign: "right" }}>
                      {e.name_en}
                    </small>
                    <small>
                      {targetText(p)} · استراحت {faNum(p.rest_sec)} ثانیه
                    </small>
                  </div>
                  <a href={ytLink(e.name_en)} target="_blank" rel="noopener noreferrer">
                    ویدیوی فرم ↗
                  </a>
                </div>
              );
            })}
          </div>
        </>
      ))}
    </>
  );
}
