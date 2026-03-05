# Minus — Strategy Card Game
## Complete Deployment Guide (100% Free)

---

## STEP 1 — Install Git (if you don't have it)

### Windows:
1. Go to https://git-scm.com/download/win
2. Download and run the installer (keep all defaults)
3. Restart your computer

### Mac:
Open Terminal and type:
```
git --version
```
If it's not installed, macOS will prompt you to install it automatically.

---

## STEP 2 — Create a free GitHub account

1. Go to https://github.com
2. Click "Sign up"
3. Use any email, any username
4. Verify your email address

---

## STEP 3 — Create a new GitHub repository

1. Log in to GitHub
2. Click the green "New" button (top left)
3. Repository name: `minus-game`
4. Leave everything else default
5. Click "Create repository"
6. **COPY the URL shown** — it looks like:
   `https://github.com/YOUR-USERNAME/minus-game.git`

---

## STEP 4 — Upload your game files to GitHub

### Option A — Using GitHub's website (easiest, no command line):

1. On your new repo page, click "uploading an existing file"
2. Drag ALL these files and folders into the upload area:
   ```
   app.py
   requirements.txt
   Procfile
   render.yaml
   templates/
     index.html
     game.html
   static/
     css/style.css
     js/game.js
   ```
   ⚠️ Make sure to upload the FOLDERS too, not just the files inside them.
3. Click "Commit changes"

### Option B — Using Git command line:

Open Terminal (Mac) or Git Bash (Windows) in your minus-game folder:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/minus-game.git
git push -u origin main
```

---

## STEP 5 — Deploy FREE on Render.com

1. Go to https://render.com
2. Click "Get Started for Free"
3. Sign up using your **GitHub account** (click "Continue with GitHub")
4. Authorize Render to access your GitHub

5. On the Render dashboard, click **"New +"** → **"Web Service"**

6. Click **"Connect account"** next to GitHub → select your `minus-game` repo

7. Fill in the settings:
   - **Name:** `minus-card-game` (or anything you like)
   - **Region:** Choose closest to you
   - **Branch:** `main`
   - **Runtime:** `Python 3`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn --worker-class eventlet -w 1 app:app --bind 0.0.0.0:$PORT`

8. Under **"Instance Type"** → select **"Free"**

9. Click **"Create Web Service"**

10. Wait 2-3 minutes for it to build and deploy.

11. Render gives you a URL like:
    **`https://minus-card-game.onrender.com`**

    🎉 **That's your live game URL — share it with friends!**

---

## STEP 6 — How to play with friends

1. Open `https://YOUR-APP.onrender.com` in your browser
2. Enter your name → click **"Create Game"**
3. A 6-letter code appears (e.g. `AB12CD`)
4. **Share that code** with up to 3 friends via WhatsApp, Discord, etc.
5. Friends open the same URL, enter their name + the code → click **"Join Game"**
6. Once everyone is in, you (the host) click **"Start Game"**

---

## Game Rules Summary

| | |
|---|---|
| Players | 2–4 |
| Rounds | 10 |
| Hand | 5 cards |
| Goal | Lowest score wins |

**Card values:** K=14, Q=12, J=0, A=1, Numbers=face value

**Each turn (correct order):**
1. **① Discard** — Click a card in your hand to select it, then click "Discard Selected"
2. **② Draw** — Click "Draw from Deck" for a random card, OR click the glowing discard pile card to take it

**Duplicate Discard:** If you have 2+ cards of the same value, click "Discard All" to discard them all at once, then draw one.

**⚡ SHOW:** Call at the very START of your turn (before discarding). Ends the round immediately.
- You have the lowest hand → everyone scores normally, no penalty
- You DON'T have lowest → you get **+25 penalty points**

---

## Troubleshooting

**"Game not found" error:**
- Make sure everyone types the code in CAPITAL LETTERS
- The code is exactly 6 characters

**App loads but game doesn't work:**
- The free Render tier "sleeps" after 15 minutes of inactivity
- First visit after sleeping takes ~30 seconds to wake up
- Just refresh the page after 30 seconds

**Want to update the game?**
- Edit your files, re-upload to GitHub
- Render automatically detects the change and re-deploys in ~2 minutes

---

## File Structure
```
minus-game/
├── app.py              ← Flask backend (all game logic)
├── requirements.txt    ← Python packages
├── Procfile            ← How to start the app
├── render.yaml         ← Render.com config
├── templates/
│   ├── index.html      ← Lobby (create/join)
│   └── game.html       ← Game table
└── static/
    ├── css/
    │   └── style.css   ← All styling
    └── js/
        └── game.js     ← Real-time client
```
