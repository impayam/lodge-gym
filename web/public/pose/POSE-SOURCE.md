# Pose model of the guide camera: source and license

`pose_landmarker_lite.task` is the on-device pose check of the progress-photo guide camera (SPEC-v10.1; PR #26
review, Payam 2026-10-17). It finds the body's 33 landmarks in the camera frame on the phone; nothing is sent anywhere.

- **Work:** MediaPipe Pose Landmarker, lite, float16, version 1 (Google).
- **Source:** https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
  (the same file as `.../float16/latest/...`, published 2023-04-27).
- **Documentation and model card:** https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
- **SHA-256:** `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` (5,777,746 bytes). `npm run build`
  checks it and fails if the file differs.
- **Runtime:** `@mediapipe/tasks-vision` 1.0.1 from npm (Apache-2.0), pinned exactly in package.json; Vite copies its
  WebAssembly files into `dist/assets/` with a content hash.
- **License:** Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0
- **Changes:** none. The file is used unmodified.

Download on first use of the camera (then kept by the service worker for offline use): the model 5.8 MB plus the
runtime 11.8 MB (WebAssembly, about 3.4 MB compressed) and 0.5 MB of code. The app credits it in Settings → About.
