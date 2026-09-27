import { faNum } from "../../../worker/lib/digits";
import { daysBetween } from "../../../worker/lib/time";
import type { ProgramDay } from "../../../worker/lib/types";
import { faHM, jalali } from "../format";
import { activeSession, dayInfo, exerciseMap, homeModel, newSession } from "../model";
import { navigate, saveSession, today, useStore } from "../store";
import { HistoryItem } from "./HistoryItem";

export function Home() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const t = today();
  const m = homeModel(boot, sessions, t);
  const act = activeSession(sessions);
  const days = boot.program.days;
  const next = days.find((d) => d.id === m.next.dayId) ?? days[0];
  const exMap = exerciseMap(boot);

  const start = async (day: ProgramDay) => {
    if (act) return navigate("session", act.id);
    const s = newSession(boot, day, t);
    await saveSession(s);
    navigate("session", s.id);
  };

  let why = "اولین جلسه‌ات؛ از روز ۱ شروع کن.";
  if (m.next.programChanged) why = "برنامه به‌روز شده؛ از روز ۱ برنامه‌ی جدید شروع کن.";
  else if (m.next.last) {
    const ago = daysBetween(m.next.last.local_date, t);
    const when = ago === 0 ? "امروز" : ago === 1 ? "دیروز" : `${faNum(ago)} روز پیش`;
    why = `آخرین جلسه: ${dayInfo(boot, m.next.last.program_day_id).name_fa}، ${when}.`;
  }

  const dots = Math.max(4, m.weekDone);
  return (
    <>
      {act ? (
        <section class="card next open" data-testid="next-card">
          <div class="eyebrow">جلسه‌ی باز</div>
          <div class="big">
            {dayInfo(boot, act.program_day_id).name_fa}
            <span class="ltr">{dayInfo(boot, act.program_day_id).name_en}</span>
          </div>
          <div class="why">
            شروع: {jalali(act.local_date)}، ساعت <span class="num">{faHM(act.started_at, boot.settings.timezone)}</span>
          </div>
          <button class="btn btn-primary btn-block" type="button" onClick={() => navigate("session", act.id)}>
            ادامه‌ی جلسه
          </button>
        </section>
      ) : (
        <section class="card next" data-testid="next-card">
          <div class="why">{why}</div>
          <div class="big">
            جلسه‌ی بعدی: {next.name_fa}
            <span class="ltr">{next.name_en}</span>
          </div>
          <div class="why">
            {next.focus_fa} · {faNum(next.exercises.length)} حرکت · حدود {faNum(next.est_minutes)} دقیقه
          </div>
          {m.rest ? <div class="ss-note">امروز استراحت بهتر است. دیروز و پریروز تمرین کردی؛ طبق برنامه بیشتر از دو روز پشت‌سرهم تمرین نکن.</div> : null}
          <button class="btn btn-primary btn-block" type="button" onClick={() => void start(next)}>
            شروع
          </button>
        </section>
      )}

      <h2>این هفته</h2>
      <div class="card weekcard" data-testid="week-strip">
        <div>
          <b class="num">
            {faNum(m.weekDone)}
            <small> از ۴</small>
          </b>
          <br />
          <small>جلسه در این هفته</small>
        </div>
        <div class="dots" aria-hidden="true">
          {Array.from({ length: dots }, (_, i) => (
            <i class={i < m.weekDone ? "on" : ""} />
          ))}
        </div>
      </div>

      {!act ? (
        <>
          <h2>یا یک روز دیگر را انتخاب کن</h2>
          <div class="daygrid">
            {days.map((d) => (
              <button type="button" class={`dayopt${d.id === next.id ? " is-next" : ""}`} onClick={() => void start(d)}>
                <b>{d.name_fa}</b>
                <small class="ltr" style={{ textAlign: "right" }}>
                  {d.name_en}
                </small>
                <small>{exMap.get(d.exercises[0]?.exercise_id)?.name_fa}</small>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <h2>جلسه‌های اخیر</h2>
      <div class="stack">
        {m.recent.length ? (
          m.recent.map((s) => <HistoryItem s={s} boot={boot} />)
        ) : (
          <div class="empty">هنوز جلسه‌ای ثبت نشده. بعد از اولین تمرین اینجا نمایش داده می‌شود.</div>
        )}
      </div>
    </>
  );
}
