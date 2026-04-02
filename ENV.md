# Environment setup

Create `.env` in project root with:

- `MONGODB_URI` - MongoDB Atlas connection string
- `JWT_SECRET` - random long secret for JWT signing (do not use a bcrypt hash; `$` in `.env` is treated as variable expansion and will break the value unless escaped)
- `SMTP_HOST` - SMTP server host
- `SMTP_PORT` - SMTP port (587 or 465)
- `SMTP_USER` - SMTP username/email
- `SMTP_PASS` - SMTP password or app password

Admin login email/password are hardcoded in `lib/adminCredentials.ts` (dev only).

## OTP cache

OTP is stored in node memory cache (`lib/otpStore.ts`), not in DB. On server restart, pending OTPs are lost.

## Notes

- MongoDB connection is singleton in `lib/db.ts`.
- Auth uses JWT cookie `auth_token`.
- Signup sends OTP through SMTP (`lib/mailer.ts`).

## Playwright (TikTok automation & session capture)

After `npm install`, browsers are installed via the `postinstall` script (`playwright install chromium`). On **Ubuntu/Debian**, install OS libraries once:

```bash
npx playwright install-deps chromium
```

### Visible browser (sign-in / uploads)

By default the app runs Chromium **headed** (a real window). That works on Windows and macOS, and on **Linux with a desktop** or **remote desktop**.

On a **headless Linux server** (no monitor), a headed browser needs a **virtual display**:

```bash
sudo apt install -y xvfb
xvfb-run -a npm run start
# or for dev:
xvfb-run -a npm run dev
```

Alternatively use **SSH X11 forwarding** (`ssh -X`) or **VNC** so `DISPLAY` is set.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `PLAYWRIGHT_HEADLESS` | `true` = no window (for servers without GUI; TikTok may behave differently). `false` or unset = visible browser (recommended for **Capture session**). |
| `PLAYWRIGHT_DOCKER` | Set `true` in containers to add `--no-sandbox` etc. when the host is not Linux. |
| `PLAYWRIGHT_CHROMIUM_ARGS` | Extra space-separated Chromium flags. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Custom Chromium/Chrome binary path. |
| `PLAYWRIGHT_CHANNEL` | e.g. `chrome` to use installed Google Chrome. |
| `TIKTOK_PROXY_TRAFFIC_LOG` | Set `1` to log **estimated** proxy egress per upload (sums `Content-Length` on responses, top hostnames, resource types, main-frame navigations, and main `goto` time). Chunked responses without length are not counted. |
| `TIKTOK_BLOCK_NON_ESSENTIAL` | **Upload worker only.** When unset or `1`, blocks **fonts**, optional **images** (see below), known third-party trackers (Google Analytics / GTM / DoubleClick / Facebook pixel hosts), and **`beacon`** requests. Does **not** block `ttwstatic`, `effectcdn`, or music CDNs. Set `0` to disable all of this if Studio misbehaves. |
| `TIKTOK_BLOCK_STUDIO_IMAGES` | Only used when `TIKTOK_BLOCK_NON_ESSENTIAL` is on. Default blocks most **images** except URLs that look music-related (`ies-music`, `/music`, etc.). Set `0` to load all images again (still blocks fonts + trackers). |
| `HUMAN_TIMING_SCALE` | Multiplier for **human-like** pauses in the upload flow (`humanPause`, `scaledHumanRand`, `humanScroll`, caption typing). Default **`0.72`** (~28% shorter). Set **`1`** to restore previous pacing. |
| `TIKTOK_REUSE_UPLOAD_CONTEXT` | When **not** `0`/`false` (default: **on**), successful uploads **return the Playwright `BrowserContext` to a pool** keyed by account + proxy. The **next** upload for the same account/proxy reuses it so **JS/effect chunks hit HTTP cache** and proxy download drops a lot on repeat runs. Set `0` for a fresh context every time. Only applies when a **shared** browser is used (Mongo runner / queue workers). |
| `TIKTOK_UPLOAD_CONTEXT_POOL_MAX` | Max pooled contexts (default **16**). Oldest evicted when full. |
| `UPLOAD_VIDEO_FFMPEG` | Set `1` / `true` to run **FFmpeg** before upload: H.264 ~720p wide, CRF 28, AAC 96k — **smaller file = less upload bytes** through the proxy. Requires `ffmpeg` on `PATH`. If FFmpeg fails, the original file is used. |
| `UPLOAD_FFMPEG_CRF` | Video quality when FFmpeg is on (default **28**; higher = smaller file). |
| `UPLOAD_FFMPEG_MAX_WIDTH` | Max width in px (default **720**). |
| `UPLOAD_GOTO_RETRIES` | Retries for the **first** `page.goto` to TikTok Studio when the proxy tunnel fails (`net::ERR_TUNNEL_CONNECTION_FAILED`, etc.). Default **3**. |
| `UPLOAD_GOTO_RETRY_DELAY_MS` | Pause between those retries (default **5000** ms). |

If you cannot run a browser on the server, paste **Playwright `storageState` JSON** on the Accounts page instead of using **Capture session**.

### CLI helper

```bash
npm run create-session
```

Saves a session to `storage/cookies/testAccount.json` after you log in and press Enter.

## Upload queue (multi-account batches)

The Mongo upload runner processes jobs in **parallel waves**: each wave runs up to the **per-upload** `parallelism` from the form (capped by `UPLOAD_PARALLEL_BATCH_SIZE` when set). If the env var is **unset**, the ceiling is **32** so UI choices up to 32 are honored. Jobs are claimed from the **same** `uploadId` batch when possible so one user’s batch is not interleaved with another’s.

| Variable | Default | Purpose |
|----------|---------|---------|
| `UPLOAD_PARALLEL_BATCH_SIZE` | *(unset → 32)* | Server-wide max concurrent jobs per wave (max 32). Set lower (e.g. `4`) on small hosts to limit RAM/CPU. |
| `UPLOAD_BATCH_GAP_MS` | `0` | Extra pause (ms) after a wave finishes before the next poll cycle. |
| `UPLOAD_POLL_INTERVAL_MS` | `2500` | Sleep when the queue is empty. |

The old `UPLOAD_JOB_START_DELAY_MS` stagger between starts was removed so each wave starts **in parallel** (one shared Chromium, separate contexts per account).

Progress ETA on `/api/upload/status/[uploadId]` uses the same batch size to estimate “waves” remaining.

### Retries & “loops”

| Variable | Default | Purpose |
|----------|---------|---------|
| `UPLOAD_MAX_ATTEMPTS` | `1` | **One** Playwright run per upload row. Set `2` only if you explicitly want a retry after failure. |
| `UPLOAD_RETRY_DELAY_MS` | `15000` | Used only when `UPLOAD_MAX_ATTEMPTS` &gt; 1. |

Per-account upload locks are **no longer used** — the same TikTok account may be automated by more than one job at a time (risk of duplicate posts or TikTok conflicts). Older History rows may still show `account_lock_busy`.

### Human-like Studio pacing (Playwright)

Slower typing, 2–3s pauses, and light scrolling are enabled in `automation/uploadWorker.ts` via `lib/humanBehavior.ts`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `HUMAN_PAUSE_MIN_MS` | `2000` | Minimum pause between major steps (ms). |
| `HUMAN_PAUSE_MAX_MS` | `3500` | Maximum pause (ms). |
| `TIKTOK_CAPTION_CHAR_DELAY_MIN_MS` | `70` | Per-character typing gap (min). |
| `TIKTOK_CAPTION_CHAR_DELAY_MAX_MS` | `160` | Per-character typing gap (max). |
| `TIKTOK_MUSIC_RETRY` | unset | Set to `1` to allow **one** retry if sound verification fails (default: no music retry). |

### Bulk @username rename (Playwright)

Defaults are **slow** so you can watch the browser and server logs. Success is reported only after **verification** (navigate to `/@newhandle` and confirm the page is not a “not found” state).

| Variable | Default | Purpose |
|----------|---------|---------|
| `RENAME_DEBUG` | on | Set to `0` to silence `[RENAME …]` console lines. |
| `RENAME_PAUSE_MIN_MS` | `8000` | Minimum pause between rename steps (ms). |
| `RENAME_PAUSE_MAX_MS` | `18000` | Maximum pause (ms). |
| `RENAME_USERNAME_CHAR_DELAY_MS` | `120` | Delay between each character when typing the new handle. |
| `RENAME_BETWEEN_ACCOUNTS_MS` | `25000` | Wait between processing multiple accounts in one job (ms). |
| `RENAME_SCREENSHOT_DIR` | unset | If set (e.g. `storage/rename-debug`), saves PNGs at key steps. |
