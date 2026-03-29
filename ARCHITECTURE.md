# TikTok Multi-Account MVP – Architecture

This document describes the full architecture of the project: what is implemented, how pieces interact, and what remains to complete the MVP.

---

## 1. Overall System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BROWSER (User)                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Next.js App (React)                                                 │   │
│  │  • Dashboard  • Accounts  • Upload  • History                         │   │
│  │  • Sidebar navigation                                                │   │
│  └───────────────────────────────┬─────────────────────────────────────┘   │
└──────────────────────────────────┼─────────────────────────────────────────┘
                                   │ fetch /api/*
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     NEXT.JS SERVER (Node.js)                                 │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐ │
│  │  API Routes          │  │  lib/storage.ts     │  │  automation/        │ │
│  │  /api/accounts       │  │  • getAccounts()    │  │  uploadWorker.ts    │ │
│  │  /api/upload         │  │  • getUploadHistory │  │  • runUploadForAcct  │ │
│  │  /api/upload/cookie  │  │  • appendHistory    │  │  (Playwright)       │ │
│  │  /api/history        │  │  • updateStatus     │  └──────────┬──────────┘ │
│  │  /api/dashboard      │  └──────────┬──────────┘              │            │
│  └─────────────────────┴─────────────┼─────────────────────────┼────────────┘
└──────────────────────────────────────┼─────────────────────────┼────────────┘
                                       │ read/write              │ launch browser
                                       ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STORAGE (filesystem)              │  PLAYWRIGHT (Chromium)                  │
│  • storage/accounts.json           │  • Launch browser (headless: false)     │
│  • storage/uploadHistory.json      │  • Load storageState from cookies/*.json│
│  • storage/cookies/*.json          │  • Go to tiktok.com/upload              │
│  • storage/videos/*.mp4            │  • setInputFiles, fill caption, Post   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Flow in short:**

- **Frontend:** Next.js App Router pages (React) render the UI. User actions trigger `fetch()` calls to `/api/*` routes.
- **Backend:** API routes run on the Next.js server. They use `lib/storage.ts` to read/write JSON and the filesystem; the upload route also imports and calls `automation/uploadWorker.ts`.
- **Automation:** The upload API route calls `runUploadForAccount()` for each selected account. That function launches a real Chromium browser (Playwright), loads the account’s saved session from `storage/cookies/<name>.json`, opens TikTok’s upload page, and automates file upload, caption, and Post. Results are written back to `uploadHistory.json` via the same API route.

There is **no separate worker process**: the “worker” is the same Node process as the API (synchronous, one account after another per request).

---

## 2. Folder Structure

### `/app` (Next.js App Router)

| Path | Purpose |
|------|--------|
| `app/layout.tsx` | Root layout: fonts, `<Sidebar />`, and `<main>{children}</main>`. Wraps all pages. |
| `app/page.tsx` | Home: redirects to `/dashboard`. |
| `app/globals.css` | Global styles and Tailwind. |
| `app/dashboard/page.tsx` | **Dashboard page** (server component). Reads accounts and history via `lib/storage` and renders stats, last upload, and recent history table. |
| `app/accounts/page.tsx` | **Accounts page** (client). Lists accounts, form to add account (username + cookie file path), upload cookie JSON via `/api/upload/cookie`, delete account. |
| `app/upload/page.tsx` | **Upload page** (client). Video file input, caption textarea, account checkboxes, “Start upload” → POST to `/api/upload`. |
| `app/history/page.tsx` | **History page** (client). Fetches `/api/history` and shows table: account, video, status, timestamp, error. |
| `app/api/accounts/route.ts` | **GET** all accounts, **POST** add account (username, cookieFile). |
| `app/api/accounts/[id]/route.ts` | **DELETE** account by id. |
| `app/api/upload/route.ts` | **POST** multipart: video file, caption, accountIds (JSON). Saves video to `storage/videos/`, creates history entries, then runs `runUploadForAccount()` for each account and updates history. |
| `app/api/upload/cookie/route.ts` | **POST** multipart: file (JSON), name. Saves to `storage/cookies/<name>.json`, returns `cookieFile` path (e.g. `cookies/foo.json`). |
| `app/api/history/route.ts` | **GET** upload history. |
| `app/api/dashboard/route.ts` | **GET** dashboard payload: totalAccounts, lastUpload, uploadHistory (first 20). Used by API consumers; the dashboard page itself uses `lib/storage` directly. |

### `/automation`

| Path | Purpose |
|------|--------|
| `automation/uploadWorker.ts` | Playwright upload flow: launch browser, load storageState, go to TikTok upload, set video file, fill caption, click Post, handle “Log in” (session expired). Exports `runUploadForAccount(account, videoPath, caption)`. |
| `automation/loginSession.ts` | **Documentation only.** Explains that login is manual; no login automation. Describes how to create a storageState file (e.g. `npx playwright open`, log in, save state to `storage/cookies/<name>.json`). |

### `/storage`

| Path | Purpose |
|------|--------|
| `storage/accounts.json` | Array of account objects: `id`, `username`, `cookieFile`, `addedAt`, `lastUsedAt`. |
| `storage/uploadHistory.json` | Array of upload history items (newest first): `id`, `accountId`, `accountUsername`, `videoFileName`, `caption`, `status`, `error?`, `timestamp`. |
| `storage/cookies/` | Directory for Playwright storageState JSON files. Each file is created manually (after logging in to TikTok) or uploaded via the dashboard “Upload JSON”. |
| `storage/videos/` | Directory where the API saves uploaded MP4 files (one per upload request; same file is used for all selected accounts in that request). |

### `/lib` (utilities / services)

| Path | Purpose |
|------|--------|
| `lib/types.ts` | Shared TypeScript types: `Account`, `UploadHistoryItem`, `UploadJob`. |
| `lib/storage.ts` | All storage access: `getAccounts`, `saveAccounts`, `getAccountById`, `addAccount`, `deleteAccount`, `updateAccountLastUsed`, `getUploadHistory`, `appendUploadHistory`, `updateHistoryItemStatus`, `getStoragePath`, `getCookiePath`. Uses `process.cwd()` and `storage/` under it. |

### `/components`

| Path | Purpose |
|------|--------|
| `components/Sidebar.tsx` | Client component: sidebar nav (Dashboard, Accounts, Upload, History), highlights active route via `usePathname()`. |

### Other

- **Root:** `package.json` (Next.js, React, Playwright, Tailwind), `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `.env.example`, `ENV.md`.

---

## 3. Dashboard Features

**What exists today:**

- **Dashboard (`/dashboard`)**  
  - Total account count.  
  - Last upload: account name, video filename, status, timestamp.  
  - Quick links: “Manage accounts”, “Upload video”, “View history”.  
  - Table of recent upload history (account, video, status, time).  
  - Data comes from `getAccounts()` and `getUploadHistory()` in a server component.

- **Accounts (`/accounts`)**  
  - List all accounts (username, cookie file path, last used).  
  - Form: username, cookie file path (text).  
  - “Upload JSON” to upload a storageState file; response fills the cookie file path.  
  - “Add account” submits to `POST /api/accounts`.  
  - “Remove” calls `DELETE /api/accounts/[id]`.

- **Upload (`/upload`)**  
  - File input (MP4).  
  - Caption textarea.  
  - Checkboxes for each account.  
  - “Start upload” → `POST /api/upload` with FormData (video, caption, accountIds).  
  - Success/error message after response.

- **History (`/history`)**  
  - Table: account, video filename, status, timestamp, error (if any).  
  - Data from `GET /api/history`.

**What the user can do:** Add/remove accounts, upload cookie files, upload one video and post it to multiple accounts, and view upload history and dashboard stats.

---

## 4. Account Management

**How accounts are stored:**

- **Metadata** is in `storage/accounts.json`: one object per account with `id`, `username`, `cookieFile` (path relative to `storage/`, e.g. `cookies/tamia.json`), `addedAt`, `lastUsedAt`.
- **No passwords or tokens** are stored; only the `cookieFile` path pointing to a Playwright storageState file.

**How session cookies (storageState) are loaded:**

1. **Creating a session (manual):**  
   The app does **not** log in to TikTok. The user (or a one-off script) must log in in a browser and save Playwright’s storage state (cookies + localStorage) to a JSON file. That file is placed under `storage/cookies/` (e.g. `storage/cookies/tamia.json`). See `automation/loginSession.ts` for the intended flow (e.g. `npx playwright open https://www.tiktok.com`, log in, then save `context.storageState({ path: 'storage/cookies/yourname.json' })`).

2. **Adding the account in the dashboard:**  
   User enters a username and either types the cookie path (e.g. `cookies/tamia.json`) or uploads a JSON file via “Upload JSON”. The upload API saves the file to `storage/cookies/<name>.json` and returns the path; the user then adds the account with that path.

3. **At upload time:**  
   `uploadWorker.ts` calls `getCookiePath(account.cookieFile)`, which resolves to `path.join(process.cwd(), 'storage', account.cookieFile)`. That path is passed to `browser.newContext({ storageState: cookiePath })`, so Playwright loads that JSON and restores cookies and local storage for the TikTok tab.

**Summary:** Accounts are “credentials” only in the sense of a reference to a storageState file; the actual session is in `storage/cookies/*.json`.

---

## 5. Upload Workflow (Step-by-Step)

1. **User:** On `/upload`, selects an MP4 file, enters caption, checks one or more accounts, clicks “Start upload”.

2. **Frontend:** Builds `FormData` with `video`, `caption`, and `accountIds` (JSON array of account ids). Sends `POST /api/upload`.

3. **API route (`app/api/upload/route.ts`):**  
   - Validates file and accountIds.  
   - Creates `storage/videos/` if needed.  
   - Saves the video to `storage/videos/<timestamp>-<sanitized-name>.mp4`.  
   - For each selected account: creates an `UploadHistoryItem` (status `pending`), appends it to `uploadHistory.json`.  
   - For each of those history entries (and corresponding account):  
     - Sets status to `uploading`.  
     - Calls `runUploadForAccount(account, videoPath, caption)`.  
     - On success: sets status `success`, updates account `lastUsedAt`.  
     - On failure: sets status `failed` and stores `error`.  
   - Returns `{ ok: true, videoPath, processed }`.

4. **Worker (`runUploadForAccount`):**  
   - Resolves cookie path and video path (absolute).  
   - Launches Chromium (headless: false).  
   - Creates a context with `storageState: cookiePath`.  
   - Opens a page, goes to `https://www.tiktok.com/upload?lang=en`.  
   - If “Log in” is visible → closes browser, returns “Session expired…”.  
   - Finds `input[type="file"]`, sets the video file.  
   - Finds `[contenteditable="true"]`, fills caption.  
   - Clicks “Post” (or “Publish” fallback).  
   - Waits, then closes browser and returns success/failure.

5. **User:** Sees success message and can open Dashboard or History to see status per account. Browser windows open and close per account during the request (sequential).

---

## 6. Automation Worker (Playwright)

**How the browser is launched:**

- In `uploadWorker.ts`, `chromium.launch({ headless: false, args: ['--no-sandbox'] })`. So a visible Chromium window is used (required for MVP to avoid some detection issues and to let the user see progress).

**How cookies/session are loaded:**

- After launch, a new context is created with `storageState: cookiePath`.  
- `cookiePath` is the full path to a JSON file under `storage/cookies/` (e.g. `storage/cookies/tamia.json`).  
- That file must be Playwright’s storage state format (cookies + localStorage). Playwright restores that state into the context so the page loads as if the user were already logged in.

**How the upload page is automated:**

1. `page.goto(TIKTOK_UPLOAD_URL)` → `https://www.tiktok.com/upload?lang=en`.  
2. Check for “Log in” text → if visible, treat as session expired and exit.  
3. `page.locator('input[type="file"]').first().setInputFiles(absoluteVideoPath)` to choose the video.  
4. Short wait (2s).  
5. `page.locator('[contenteditable="true"]').first()` → click and `fill(caption)`.  
6. Locate button with text “Post” (or “Publish”), click it.  
7. Wait (5s, and optionally more if “Posting” is still visible).  
8. Close browser and return success/failure.

Selectors are string-based and may need updates if TikTok’s DOM changes (see “Potential failure points” below).

---

## 7. Data Storage

| Data | Where it is stored |
|------|--------------------|
| **Account list (metadata)** | `storage/accounts.json`. Each item: `id`, `username`, `cookieFile`, `addedAt`, `lastUsedAt`. |
| **Cookie sessions (storageState)** | `storage/cookies/*.json`. One JSON file per account (or per session). Created manually or uploaded via “Upload JSON” on the Accounts page. |
| **Uploaded videos** | `storage/videos/`. Files named like `1734567890123-original_name.mp4`. One file per “Start upload” action; that file is reused for every selected account in that request. |
| **Upload history** | `storage/uploadHistory.json`. Array of objects: `id`, `accountId`, `accountUsername`, `videoFileName`, `caption`, `status`, `error?`, `timestamp`. New items are prepended; status is updated in place by the upload API. |

All paths are under the project root (`process.cwd()`), so on a local machine everything lives under `d:\tik_tok\storage\`.

---

## 8. Missing Features / TODO (for MVP to be “complete”)

- **Session creation UX:** There is no in-app flow to “create” a storageState. Users must use an external method (e.g. `npx playwright open`, log in, save state) or upload an existing JSON. A small “Save session” helper script or in-app instructions would close this gap.

- **Cookie file existence check:** When adding an account or before upload, the app does not verify that `storage/cookies/<file>` exists. If the file is missing, Playwright will throw when loading storageState.

- **Admin / optional auth:** Simple admin login was listed as optional; it is not implemented. The dashboard and API are open to anyone who can reach the server.

- **Robustness of automation:**  
  - No retries on transient failures.  
  - Fixed timeouts and selectors; TikTok UI changes will break the flow.  
  - No explicit handling of captcha or “Verify you’re human” (session reuse is the main mitigation).

- **Upload progress feedback:** The UI shows a single success message after the whole request. There is no per-account progress (e.g. “Uploading to account 2/5”) or live status updates without refreshing.

- **Validation:** No server-side check that the uploaded “cookie” file is valid Playwright storageState JSON. No check that the video is actually MP4 or under a size limit.

- **Cleanup:** Old videos in `storage/videos/` are never deleted; could add optional retention or manual cleanup.

---

## 9. Potential Failure Points

- **Session expired / not logged in:** If the storageState is old or invalid, TikTok shows “Log in”. The worker detects this (visibility of “Log in”) and returns a clear error; history is updated to `failed` with that message. User must log in again and save a new storageState.

- **Captcha / verification:** If TikTok shows a captcha or “Verify you’re human”, the current automation does not handle it. The flow will likely time out or click the wrong thing. Mitigation: use recently created sessions and avoid aggressive automation.

- **Selector changes:** TikTok’s upload page DOM and text can change. If `input[type="file"]`, `[contenteditable="true"]`, or the “Post”/“Publish” button change, the worker will fail (timeouts or “Could not find Post/Publish button”). Updating selectors in `uploadWorker.ts` would be required.

- **Upload failure:** Network issues, TikTok errors, or unsupported video format can cause the post to fail. The worker catches exceptions and returns `success: false` with the error message; the API records this in history. The UI does not distinguish “session” vs “upload” failure beyond the error text.

- **Missing cookie file:** If `storage/cookies/<account.cookieFile>` is deleted or never created, `newContext({ storageState: cookiePath })` will throw. The error is caught and returned as a generic “Upload failed” (or similar). Adding a pre-check that the file exists would improve clarity.

- **Long-running request:** Uploads run sequentially in the same API request. With many accounts or slow TikTok responses, the HTTP request can run for a long time and may hit timeouts (browser or reverse proxy). Moving to a background job (e.g. queue + separate worker process) would be a later improvement.

- **Concurrent uploads:** If two users (or two tabs) start an upload at once, both write to `uploadHistory.json` and possibly run Playwright in parallel. For MVP with a single user this may be acceptable, but race conditions are possible.

---

## 10. Development Roadmap (Next Steps to Complete MVP)

1. **Cookie/session creation flow**  
   - Add a small Playwright script (or doc/button that runs it) that: opens TikTok, user logs in manually, then saves `context.storageState({ path: 'storage/cookies/<name>.json' })`.  
   - Or add clear in-app instructions and link to `ENV.md` / `loginSession.ts`.

2. **Validate cookie file on add/upload**  
   - When adding an account or before starting uploads: check that `storage/cookies/<cookieFile>` exists and (optionally) is valid JSON with expected Playwright structure.  
   - Show a clear error in the UI if the file is missing.

3. **Improve error handling in worker**  
   - Map common failures (e.g. “Log in” visible, missing file, timeout) to specific error messages.  
   - Optionally retry once on timeout or network errors.

4. **Basic validation**  
   - API: validate video MIME type or extension (e.g. allow only MP4), optional max file size.  
   - API: validate that cookie upload is JSON and has expected keys (cookies/origins).

5. **Optional: simple admin auth**  
   - If required: add a simple password (or username+password) check for dashboard and API (e.g. middleware or route checks using `ADMIN_PASSWORD` from env).  
   - Keep it minimal for MVP.

6. **Optional: upload progress**  
   - For better UX: use Server-Sent Events (SSE) or polling so the client can show “Uploading to account 2/5” and per-account status without refreshing.  
   - Alternatively, document that users should open History in another tab and refresh.

7. **Selector maintenance**  
   - Document where selectors live (`uploadWorker.ts`) and add a one-line “last verified” note or test that TikTok upload page still matches.  
   - When TikTok changes the page, update selectors and add fallbacks if useful.

8. **Deployment / runbook**  
   - Document how to run locally (`npm run dev`, `npx playwright install chromium`).  
   - If deploying: note that Playwright needs Chromium on the server and that long-running uploads may need a timeout/worker strategy.

This order focuses on making the MVP reliable (session creation, validation, errors) before adding optional features (auth, progress, cleanup).
