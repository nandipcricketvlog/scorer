# 🏏 Cricket Scorer — Render-Ready OBS Broadcast System

Real-time cricket scoring with OBS overlays, admin login, WebSocket updates, and **Postgres-backed match state** for proper server-side persistence.

---

## What changed

This version is ready for **Render**:
- Uses `process.env.PORT`
- Uses **secure WebSocket handling** (`ws` locally, `wss` on HTTPS)
- Stores match state in **Postgres** instead of a local JSON file
- Includes `render.yaml` so Render can provision the web service and database together
- Includes `/healthz` for Render health checks

---

## Local development

### 1) Install dependencies
```bash
npm install
```

### 2) Set environment variables
Copy `.env.example` to `.env` and fill in:
- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `DATABASE_URL`

Example local Postgres URL:
```bash
postgres://postgres:postgres@localhost:5432/cricket_scorer
```

### 3) Start the app
```bash
npm start
```

Open:
```text
http://localhost:3000/login
```

---

## Deploy to Render

### Easiest method — Blueprint deploy

1. Upload this project to GitHub
2. In Render, choose **New + → Blueprint**
3. Select your GitHub repo
4. Render will detect `render.yaml`
5. Set your `ADMIN_PASSWORD` when prompted
6. Deploy

That blueprint creates:
- one **Node Web Service**
- one **Render Postgres** database

### Manual method

If you do not want to use the blueprint:

1. Create a **Postgres** database in Render
2. Create a **Web Service** from your GitHub repo
3. Set these values:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/healthz`
4. Add environment variables:
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET`
   - `DATABASE_URL` (from your Render Postgres instance)

---

## Important deployment notes

### Match state storage
The app now stores the full match state in Postgres table `match_state`.
That means:
- match data survives restarts
- match data survives redeploys
- no dependence on local server files

### WebSockets on Render
The overlay and admin pages now automatically use:
- `ws://` on local HTTP
- `wss://` on Render HTTPS

So OBS browser sources work correctly from your public Render URL.

### Health check
Use:
```text
/healthz
```

---

## OBS overlay URLs

Replace the base URL with your Render domain:

```text
https://your-app.onrender.com/overlays/lower-third.html
https://your-app.onrender.com/overlays/scorecard.html
https://your-app.onrender.com/overlays/batsmen.html
https://your-app.onrender.com/overlays/bowling.html
https://your-app.onrender.com/overlays/runrate.html
https://your-app.onrender.com/overlays/partnerships.html
https://your-app.onrender.com/overlays/teamsheet.html
https://your-app.onrender.com/overlays/chase.html
https://your-app.onrender.com/overlays/celebrations.html
https://your-app.onrender.com/overlays/summary.html
```

---

## Required environment variables

| Variable | Required | Description |
|---|---:|---|
| `ADMIN_PASSWORD` | Yes | Password for the scoring admin panel |
| `SESSION_SECRET` | Yes | Used to sign auth cookies |
| `DATABASE_URL` | Yes on Render | Postgres connection string |
| `PORT` | No | Render sets this automatically |

---

## Project structure

```text
cricket-scorer/
├── server.js
├── package.json
├── package-lock.json
├── render.yaml
├── railway.json
├── .env.example
├── README.md
└── public/
    ├── login.html
    ├── admin/index.html
    └── overlays/
```

---

## Notes

- If `DATABASE_URL` is missing, the app falls back to **memory-only** state for local testing.
- For real deployment, use Postgres so state persists properly.
- OBS overlay URLs remain public by design because OBS browser sources do not carry your admin login session.
