# Shadow

Mobile-first video shadowing practice. Import a video or audio file and its
transcript, align sentences on a real waveform, shadow each line, and review
your take against measurements — all on your device.

Plain HTML, CSS, and JavaScript. No framework, no build step, no backend, no
accounts. Media, transcripts, recordings, and progress live in IndexedDB;
settings live in `localStorage`.

## Run locally

The app needs a real origin, not `file://`, because it uses a service worker,
AudioWorklet, and microphone permissions:

```sh
npx serve . -l 3000
# or: python -m http.server 3000
```

Open http://localhost:3000.

## Deploy on Render

Shadow is a static site, so it deploys from any Git repo with no build step.

### Option A — Blueprint (recommended)

1. Push this folder to GitHub (see below).
2. Open `https://render.com/deploy?repo=<your repo URL>`.
3. Approve the Blueprint. `render.yaml` sets the publish directory, cache
   headers, and permissions policy.

### Option B — Dashboard

New → Static Site → connect the repo, then:

| Setting | Value |
| --- | --- |
| Build Command | *(leave empty)* |
| Publish Directory | `.` |

Add the cache header manually under **Headers**:
`/*` → `Cache-Control: no-cache`. This matters: `sw.js` is cache-first, and a
stale service worker would keep serving the old build.

### Push to GitHub

```sh
git remote add origin https://github.com/<you>/shadow-app.git
git push -u origin main
```

## Updating a deployed build

Browsers keep the installed service worker until `sw.js` changes. Bump
`CACHE_NAME` in `sw.js` (for example `shadow-app-v3` → `shadow-app-v4`)
whenever you ship changes to the shell files, then commit and push.

## Notes

- Render serves over HTTPS, so microphone, camera, and AudioWorklet all work.
- Data is per-origin: the deployed site keeps its own library, separate from
  any local copy.
- Auto-transcription is deliberately not faked — the UI says so when no
  on-device model is available.
