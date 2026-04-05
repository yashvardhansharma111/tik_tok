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
| `TIKTOK_BLOCK_STUDIO_IMAGES` | Only used when `TIKTOK_BLOCK_NON_ESSENTIAL` is on. Default blocks most **images** except URLs that look music-related (`ies-music`, `/music`, `tiktokcdn.com` paths with music/sound/cover, etc.). Set `0` to load all images again (still blocks fonts + trackers). |
| `TIKTOK_PROXY_SAVINGS_MODE` | When **not** `0` (default: **on**), adds **safe** cuts on top of non-essential blocking: **source maps** (`.map`), **`manifest` / `texttrack`** types, and extra **ad/telemetry** hostnames (Google Ads, Taboola, New Relic, etc.). Does **not** block `ttwstatic`, `effectcdn`, or music APIs. Set `0` if anything breaks. |
| `TIKTOK_CHROMIUM_LEAN_AUTOMATION` | When **not** `0` (default: **on** for automation launches), adds Chromium flags that reduce **Chrome’s own** background traffic (sync, component update checks). Set `0` to disable. Does not change TikTok page behavior. |
| `HUMAN_TIMING_SCALE` | Multiplier for **human-like** pauses in most of the upload flow (`humanPause`, `scaledHumanRand`, `humanScroll`, caption typing). Default **`0.58`**. Set **`1`** to restore slower pacing. |
| `TIKTOK_MUSIC_TIMING_SCALE` | Multiplier for **music / Add sound** step delays only (often the slowest screen). Default **`0.48`**. Set **`1`** for original pacing. |
| `TIKTOK_REUSE_UPLOAD_CONTEXT` | When **not** `0`/`false` (default: **on**), successful uploads **return the Playwright `BrowserContext` to a pool** keyed by account + proxy. The **next** upload for the same account/proxy reuses it so **JS/effect chunks hit HTTP cache** and proxy download drops a lot on repeat runs. Set `0` for a fresh context every time. Only applies when a **shared** browser is used (Mongo runner / queue workers). |
| `TIKTOK_UPLOAD_CONTEXT_POOL_MAX` | Max pooled contexts (default **16**). Oldest evicted when full. |
| `UPLOAD_VIDEO_FFMPEG` | Set `1` / `true` to run **FFmpeg** before upload: H.264 ~720p wide, CRF 28, AAC 96k — **smaller file = less upload bytes** through the proxy. Requires `ffmpeg` on `PATH`. If FFmpeg fails, the original file is used. |
| `UPLOAD_FFMPEG_CRF` | Video quality when FFmpeg is on (default **28**; higher = smaller file). |
| `UPLOAD_FFMPEG_MAX_WIDTH` | Max width in px (default **720**). |
| `UPLOAD_GOTO_RETRIES` | Retries for the **first** `page.goto` to TikTok Studio when the proxy tunnel fails (`net::ERR_TUNNEL_CONNECTION_FAILED`, etc.). Default **3**. |
| `UPLOAD_GOTO_RETRY_DELAY_MS` | Pause between those retries (default **5000** ms). |
| `PROXY_STICKY_SLOT_COUNT` | `0` | **Residential sticky sessions (e.g. IPRoyal `password_session-…`).** When **`0`** or unset, each account uses its **username** in the session string (one proxy identity per account). When set to **≥ 2** (e.g. **`10`**), accounts are hashed into **`slot0`…`slot9`** so **several accounts share the same proxy session** before you exhaust slots — fewer unique rotations than “new session every account”. Aim for **~2–3 accounts per slot**: `N ≈ ceil(total_accounts / 3)` (30 accounts → **`10`**). Retries still append `-1`, `-2` to the password. |
| `STORAGE_JANITOR` | *(on)* | Set **`0`** to disable periodic cleanup of old **`storage/debug`** and **`storage/tmp-uploads`** subfolders. |
| `STORAGE_JANITOR_MAX_AGE_MS` | `86400000` (24h) | Delete subdirs **older than** this (mtime). |
| `STORAGE_JANITOR_INTERVAL_MS` | `3600000` (1h) | How often the janitor runs. |
| `TIKTOK_UPLOAD_KEEP_DEBUG_ON_SUCCESS` | *(unset)* | If **`1`** / **`true`**, keep the **`storage/debug/<runId>`** folder after a **successful** upload (default: **delete** it on success to save disk; failures always keep the folder). |

**Proxy MB (~25 MB goal):** Most download bytes are TikTok’s own **`fetch` + scripts + CDNs** (`ttwstatic`, `effectcdn`) — those **cannot** be blocked without breaking Studio or music. A **~25 MB** `Content-Length` count is most realistic on the **second consecutive upload** for the **same account** (pooled context + HTTP cache), with `TIKTOK_PROXY_SAVINGS_MODE` on, `UPLOAD_VIDEO_FFMPEG=1` if you bill upload traffic, and the same region. **Cold** first loads are often **~30–40+ MB** counted.

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

Multi-account batches can also set **`staggerSeconds`** and optional **`scheduledStartAt`** (ISO time) on the upload form. Each job row gets a **`notBefore`** time: rotation follows **account selection order**, with spacing `staggerSeconds` starting from “now” or from **`scheduledStartAt`**. The worker only claims jobs whose `notBefore` has passed, so you can queue a full day in one submit.

Admins can set **`maxLinkedAccounts`** per user (`PATCH /api/admin/users/[id]`); unset / `null` means unlimited.

With **`uniqueCaptionPerAccount`** on the upload form, the server calls Groq once per selected account so each row gets a **different caption** (helps when posting the same clip to many accounts). Same **`GROQ_API_KEY`** / **`GROQ_MODEL`** as single-caption AI.

Progress ETA on `/api/upload/status/[uploadId]` uses the same batch size to estimate “waves” remaining.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TIKTOK_UPLOAD_SAME_PAGE_CHAIN` | *(on)* | Set **`0`** to disable **same-page chaining**: after each successful post, the worker looks for **another pending job for the same account** (any batch), reuses **one** browser context + **one** tab, `goto` upload URL again, and uploads the next video **without** a new context/login. Reduces repeated Studio cold-load traffic when users queue multiple videos per account. |
| `UPLOAD_CHAIN_GAP_MIN_MS` | `1000` | Random pause **before** starting the next chained upload (min). |
| `UPLOAD_CHAIN_GAP_MAX_MS` | `3000` | Random pause before the next chained upload (max). |

Parallel browsers are unchanged: **each account slot** can still run concurrently; chaining only **serializes multiple jobs for the same account** on one page. Expect **~5–8 MB per repeat** only if **HTTP cache** hits (measure with `TIKTOK_PROXY_TRAFFIC_LOG=1`); the **first** Studio load per context often remains **~25–40 MB+** depending on region and proxy.

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
