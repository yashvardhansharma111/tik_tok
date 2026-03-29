# Multi-account upload (MVP)

## How uploads work: **parallel**

- **Current behaviour:** Uploads run **in parallel** — one Playwright browser per account, all at the same time.
- For each selected account we launch a browser, load that account’s session, upload the video, then close that browser. All accounts are processed concurrently.
- **Note:** With 6 accounts you’ll see 6 browser windows open at once. Ensure your machine has enough RAM/CPU; if it’s too heavy, you can switch the API back to sequential (one `await` per account in a loop).

## Session creation from the dashboard

1. Go to **Accounts**.
2. For an account, click **Create session**.
3. A browser window opens on the TikTok login page.
4. Log in **manually** (no passwords stored in the app).
5. When you’re logged in, return to the dashboard and click **Save session**.
6. The session is saved to `storage/cookies/<username>.json` and the account’s cookie file is updated.

Only one “Create session” can be in progress at a time. Finish by saving (or close the browser and start again if needed).

## The six accounts

The app is set up with these usernames and cookie paths (no passwords or emails in the repo):

| Username           | Cookie file                    |
|--------------------|--------------------------------|
| tamia.buckner      | cookies/tamia.buckner.json     |
| monica.hull4       | cookies/monica.hull4.json      |
| marilyn.hubbard68  | cookies/marilyn.hubbard68.json |
| lola.lloyd5        | cookies/lola.lloyd5.json       |
| erin.williams959   | cookies/erin.williams959.json  |
| charlie.jenkins721 | cookies/charlie.jenkins721.json|

Create a session for each (Create session → log in → Save session), then use **Upload** to select which accounts to post to. One video is uploaded to each selected account in sequence.
