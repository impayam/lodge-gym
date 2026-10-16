# SPEC v10.1: Photo guide camera (addendum)

Status: requested by Payam on 2026-10-15. Same CLAUDE.md rules. Build after the M13 calendar work, as its own PR (or the last step of M13 if Payam says so). UI only from the Pulse library.

## Photo guide camera
Goal: every progress photo framed the same way (head, body, distance, angle), so photos can be compared and the Coach can read them.

**How (in-app camera, not the iOS camera):** Progress photos → **Camera** opens an in-app camera screen (`getUserMedia`, front or back camera, 1× lens, no digital zoom). The native file picker stays as "From library". **STOP:** before building, verify on Payam's iPhone that the in-app camera works in the Home Screen app (standalone PWA) and in Safari, and report; if it does not, stop and tell him.

On the camera screen:
1. **Body outline guide** per pose (front / side / back): a thin line silhouette with a **head line** and a **feet line**. Payam steps back until his head and feet touch those lines, so the distance (and so the size) is the same every time.
2. **Ghost of the last photo** of the same pose at ~25 % opacity (toggle), to match position and angle.
3. **Level indicator** from the phone's motion sensor: turns violet when the phone is straight up (not tilted forward/back); the shutter warns when tilted more than 3°. (iOS asks for motion permission once; if denied, the level is hidden and everything else works.)
4. **Timer** 3 / 5 / 10 s with a countdown sound/flash, for a phone on a stand or leaning on a wall; burst of 3 photos, Payam keeps the best one.
5. **Same settings saved:** camera (front/back), pose, timer and the outline position are remembered per pose, so the next photo starts identical.
6. Short tips on first use: same place, same light, same time of day, relaxed pose, same clothing.

**Check after taking (no AI, on the phone, offline):** optional on-device pose detection checks that head and feet are on the guide lines and the body is centred; if not, "Step back a bit / move left" before saving. **STOP:** report the added download size of the pose model; if it is more than ~5 MB, show Payam the size first and build without it unless he approves.

Rules: photos still go through the existing pipeline (resize, EXIF/location stripped, R2, offline queue). Library classes only; reduced motion respected; VoiceOver labels on every control. Tests: guide/ghost/timer/level states (camera mocked in tests); screenshots of the camera screen per pose.
