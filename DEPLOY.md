# Deploying Research Radar to the internet (free)

Goal: a public URL anyone can open. Two steps — put code on GitHub, then
let Render run it.

## Step 1 — Put the code on GitHub

1. Make a free account at <https://github.com>.
2. Click the **+** (top right) → **New repository**.
   - Name: `research-radar`
   - Leave it **Public**, don't add a README (you already have one).
   - Click **Create repository**.
3. On your Mac, in this folder, run the commands GitHub shows you. They look like:
   ```bash
   cd /Users/ranjandas/Github/research-radar
   git init
   git add .
   git commit -m "Research Radar"
   git branch -M main
   git remote add origin https://github.com/<your-username>/research-radar.git
   git push -u origin main
   ```
   Refresh the GitHub page — your files should appear.

## Step 2 — Run it on Render

1. Make a free account at <https://render.com> and click **"Sign in with GitHub"**
   (this lets Render see your repos).
2. Click **New +** → **Blueprint**.
3. Pick your `research-radar` repo. Render reads `render.yaml` automatically
   and fills everything in.
4. Click **Apply** / **Create**. It will install and start the app
   (takes ~2-3 minutes the first time).
5. When it finishes, Render gives you a URL like
   `https://research-radar.onrender.com` — that's your live website. Share it!

## Updating the site later

Whenever you change the code, just:
```bash
git add .
git commit -m "what I changed"
git push
```
Render notices the push and re-deploys automatically.

## Good to know about the free tier

- After ~15 minutes of no visitors, Render puts the app to sleep. The next
  visitor's first load takes ~30-50 seconds to wake it up, then it's fast
  again. (Paid plans stay awake.)
- That's normal and fine for a personal/demo project.
