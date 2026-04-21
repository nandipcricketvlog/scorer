# 🏏 Cricket Scorer — OBS Broadcast System

Real-time cricket scoring with Big Bash–style OBS overlays. Score from your phone, broadcast to OBS from anywhere.

---

## ⚡ Local Quick Start

```bash
cd cricket-scorer
npm install
npm start
```

Open **http://localhost:3000** — you'll be asked for a password.
Default local password: **cricket123**

---

## 🚀 Deploy to Railway (Score from Anywhere)

Railway gives you a public HTTPS URL so you can score from your phone while OBS runs on your PC at home.

### Step 1 — Create a free Railway account
Go to **railway.app** and sign up.

### Step 2 — Upload your project

**Option A: via GitHub (easiest)**
1. Create a GitHub account if you don't have one — **github.com**
2. Create a new **public** repository
3. Upload all files from this folder to it
4. In Railway: **New Project → Deploy from GitHub repo** → select your repo → Deploy

**Option B: via Railway CLI**
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Step 3 — Set environment variables

In the Railway dashboard → your project → **Variables** tab, add these two:

| Variable | Value |
|---|---|
| `ADMIN_PASSWORD` | Your chosen password (e.g. `BlueKings2024!`) |
| `SESSION_SECRET` | A long random string — generate one with the command below |

To generate a SESSION_SECRET, run this in any terminal:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4 — Get your public URL

Railway shows your URL in the dashboard, something like:
`https://cricket-scorer-production-xxxx.up.railway.app`

- **Score from your phone:** open that URL → enter password → admin panel
- **OBS on your PC:** use the same base URL for all overlay Browser Sources

### Step 5 — Update OBS Browser Sources

Replace `http://localhost:3000` with your Railway URL in every Browser Source:

```
https://your-url.up.railway.app/overlays/lower-third.html
https://your-url.up.railway.app/overlays/scorecard.html
https://your-url.up.railway.app/overlays/batsmen.html
https://your-url.up.railway.app/overlays/bowling.html
https://your-url.up.railway.app/overlays/runrate.html
https://your-url.up.railway.app/overlays/partnerships.html
https://your-url.up.railway.app/overlays/teamsheet.html
https://your-url.up.railway.app/overlays/chase.html
https://your-url.up.railway.app/overlays/celebrations.html
https://your-url.up.railway.app/overlays/summary.html
```

---

## 🔐 Security

- Admin panel and all API routes require your password
- OBS overlay URLs are **intentionally public** — OBS Browser Sources don't support login cookies
- Sessions last 7 days — you stay logged in on your phone between sessions
- Logout button is in the top-right of the admin panel

---

## ⚠️ Railway Free Tier Notes

- Match state persists between restarts but **resets on redeploy** — don't redeploy mid-match
- The free tier app may sleep after inactivity. Open the URL about 1 minute before your match
- Upgrade to $5/month Hobby plan if you want the app always awake

---

## 📁 Project Structure

```
cricket-scorer/
├── server.js              Server, API, auth, WebSocket
├── railway.json           Railway config
├── .env.example           Environment variable template
├── .gitignore
├── package.json
└── public/
    ├── login.html         Login page
    ├── admin/index.html   Scoring dashboard
    └── overlays/          10 OBS overlay files
```

## Render deployment

This project is prepared for Render using `render.yaml`.

### What changed for Render
- Postgres-backed match state using `DATABASE_URL`
- WebSocket URLs auto-switch between `ws://` and `wss://`
- Health check endpoint at `/healthz`
- Secure auth cookie support behind Render proxy

### Deploy steps
1. Push the project to GitHub.
2. In Render, create a new **Blueprint** from the repo.
3. Set `ADMIN_PASSWORD`.
4. Deploy.

### Notes
- Match state is stored server-side in Postgres instead of a local file.
- If `DATABASE_URL` is not set, the app falls back to a fresh in-memory state on startup.
