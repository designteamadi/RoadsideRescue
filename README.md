# mToyota Roadside Rescue — Online + Leaderboard Backend

A self-contained HTML5 endless runner with a real backend. Players enter their
name, WhatsApp number and email, and their results are stored in a Postgres
database. The leaderboard shows **one row per person** (their best score), and
**no two players can share the same score**, so places are never tied.

## What the backend stores per player

`name`, `email`, `phone`, `score`, `time_sec` (seconds played), `rescued`
(cars rescued), `boosts` (mToyota service pickups), `multiplier` (best combo
multiplier reached), `plays` (how many times they played), plus `created_at`
and `updated_at` timestamps.

A player is identified by their **email + phone**, so someone can play again and
again to grind for a higher score, but only ever occupies **one** leaderboard place.

---

## File structure

```
.
├── index.html            ← the game (served at your site root)
├── api/
│   └── leaderboard.js     ← the backend (Vercel serverless function)
├── package.json
├── vercel.json
├── .env.example
└── .gitignore
```

---

## Deploy in 5 steps

### 1. Put the code on GitHub
Create a new **empty** repository on GitHub, then from this folder:

```bash
git init
git add .
git commit -m "mToyota Roadside Rescue + leaderboard"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

### 2. Import the repo into Vercel
- Go to **vercel.com → Add New → Project** and import your GitHub repo.
- Framework preset: **Other** (no build step needed). Leave build/output settings empty.
- Click **Deploy**. It will go live, but scores won't save yet — add the database next.

### 3. Add the database (Neon Postgres)
In your Vercel project: **Storage → Create Database → Neon (Serverless Postgres)**,
follow the prompts (free plan is fine), and **connect it to this project**.

This automatically injects a `DATABASE_URL` environment variable. You don't have
to create any tables — the function creates them on first use.

### 4. Add your admin token
In **Project → Settings → Environment Variables**, add:

| Name          | Value                                  |
|---------------|----------------------------------------|
| `ADMIN_TOKEN` | a long random string you choose        |

### 5. Redeploy
**Deployments → … → Redeploy** so the new env vars take effect. Done — your game
is live at `https://<your-project>.vercel.app` and scores now persist.

> To embed the game in the mToyota app, point the webview at that Vercel URL.

---

## Getting the player data (export)

Only you can read the personal data, using your secret token:

- **JSON:** `https://<your-project>.vercel.app/api/leaderboard?admin=YOUR_TOKEN&full=1`
- **CSV (download):** `https://<your-project>.vercel.app/api/leaderboard?admin=YOUR_TOKEN&full=1&format=csv`

The public leaderboard (`/api/leaderboard`) only ever returns names and scores —
never emails or phone numbers.

---

## Running it locally (optional)

```bash
npm install -g vercel
vercel link          # link to your Vercel project
vercel env pull      # pulls DATABASE_URL etc. into .env.local
vercel dev           # serves the game + API at http://localhost:3000
```

Opening `index.html` directly (without the API) still runs the game; it just
falls back to a demo leaderboard and can't save scores.

---

## Notes & things you may want to tune

- **Anti-cheat:** scores are submitted from the browser, so a determined user
  could forge a request. The server applies a basic plausibility clamp
  (`api/leaderboard.js`, the `plausible` calculation). For a real prize contest,
  tighten this or add a signed token / server-side score validation.
- **Resetting the contest:** to start a fresh week, clear the table. In the Neon
  dashboard SQL editor run: `TRUNCATE players;`
- **CORS:** the API currently allows any origin (`*`) so the game works embedded
  anywhere. Restrict `Access-Control-Allow-Origin` in `setCors()` if you want to
  lock it to one domain.
- **Privacy:** you are collecting personal data (name, phone, email). Make sure
  the in-game consent text and your privacy policy cover how it's stored and used.
