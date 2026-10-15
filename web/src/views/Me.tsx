// Me tab (SPEC-v8 §6.06): body weight, progress photos, and the screens that used to be tabs: Program, Planner,
// AI reports, Backup and export, Settings.

import { useEffect, useState } from "preact/hooks";
import { fetchUsage, type AiUsage } from "../ai";
import { BodyCard } from "../components/BodyCard";
import { IconChevron, IconDownload, IconPlanner, IconProgram, IconSettings, IconSpark } from "../components/PulseIcons";
import { Empty, LoadError, Loading } from "../components/States";
import { dayMonth, plural } from "../format";
import { activeProgramInfo, homeModel, programName, trainingSince } from "../model";
import { loadPhotos, navigate, openPhotos, photoSrc, today, useStore, type ViewName } from "../store";
import { poseLabel } from "./Photos";
import { planDay } from "./Planner";

function Row({ icon, tone, title, sub, onOpen, testid }: { icon: preact.JSX.Element; tone: string; title: string; sub: string; onOpen: () => void; testid: string }) {
  return (
    <button type="button" class="list-row press" data-testid={testid} onClick={onOpen}>
      <span class={`well icon-well ${tone}`}>{icon}</span>
      <span class="list-row__text">
        <span class="t-title">{title}</span>
        <span class="caption">{sub}</span>
      </span>
      <span class="list-row__chevron">
        <IconChevron size={16} />
      </span>
    </button>
  );
}

function PhotosCard() {
  const photos = useStore((s) => s.photos);
  const load = useStore((s) => s.loads.photos);
  useEffect(() => {
    void loadPhotos();
  }, []);
  // The latest four, oldest first (the order they were taken).
  const latest = photos.slice(0, 4).reverse();
  return (
    <section class="card l-col l-gap-12" data-testid="me-photos">
      <div class="card__head">
        <h2 class="card__title l-m0">Progress photos</h2>
        <span class="caption num">{plural(photos.length, "photo")}</span>
      </div>
      {latest.length ? (
        <div class="l-grid-4 l-gap-8">
          {latest.map((p) => (
            <button type="button" class="photo-thumb press" aria-label={`${poseLabel(p.pose)} photo, ${dayMonth(p.local_date)}`} onClick={() => openPhotos({ open: p.id })}>
              <span class="photo-thumb__frame well">
                <img src={photoSrc(p, "thumb")} alt="" loading="lazy" />
              </span>
              <span aria-hidden="true">{dayMonth(p.local_date)}</span>
            </button>
          ))}
        </div>
      ) : load?.status === "error" ? (
        <LoadError what="Couldn't load your photos." error={load.error} onRetry={() => void loadPhotos()} />
      ) : load?.status !== "done" ? (
        <Loading label="Loading your photos" heights={[96]} />
      ) : (
        <Empty>No photos yet. After a session you can add front, side and back photos.</Empty>
      )}
      <div class="l-row l-gap-8">
        <button type="button" class="clay press btn btn--fit t-pink l-grow" data-testid="me-add-photo" onClick={() => openPhotos()}>
          Add photo
        </button>
        <button type="button" class="clay press btn btn--fit t-muted l-grow" data-testid="me-compare" disabled={photos.length < 2} onClick={() => openPhotos({ compare: true })}>
          Compare two dates
        </button>
      </div>
    </section>
  );
}

export function Me() {
  const boot = useStore((s) => s.boot)!;
  const sessions = useStore((s) => s.sessions);
  const online = useStore((s) => s.sync.online);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  useEffect(() => {
    fetchUsage()
      .then(setUsage)
      .catch(() => setUsage(null));
  }, [online]);

  const since = trainingSince(boot);
  const next = boot.program.days.find((d) => d.id === homeModel(boot, sessions, today()).next.dayId) ?? boot.program.days[0];
  const open = (v: ViewName) => () => navigate(v);

  return (
    <main class="page" data-testid="me">
      <header class="page-head">
        <div class="l-col l-gap-2">
          <h1 class="h-page">Me</h1>
          {since ? <span class="page-head__sub">Training since {dayMonth(since)}</span> : null}
        </div>
      </header>

      <BodyCard />
      <PhotosCard />

      <section class="card card--list" aria-label="More">
        <Row testid="me-program" icon={<IconProgram />} tone="t-pink" title="Program" sub={`${programName(activeProgramInfo(boot))}, active`} onOpen={open("program")} />
        <Row testid="me-planner" icon={<IconPlanner />} tone="t-orange" title="Planner" sub={`Plan the next session: ${next.name_en}`} onOpen={() => planDay(next)} />
        <Row
          testid="me-ai"
          icon={<IconSpark />}
          tone="t-violet"
          title="AI reports"
          sub={usage ? `This month ~$${usage.month.cost_usd.toFixed(2)}, ${usage.model}` : "Reports, overviews and plan advice"}
          onOpen={open("ai")}
        />
        <Row testid="me-backup" icon={<IconDownload />} tone="t-muted" title="Backup and export" sub="Weekly copy every Monday" onOpen={open("backup")} />
        <Row testid="me-settings" icon={<IconSettings />} tone="t-muted" title="Settings" sub="Units, week start, Face ID lock, Apple Watch" onOpen={open("settings")} />
      </section>
    </main>
  );
}
