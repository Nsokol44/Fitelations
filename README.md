# Fitelations

Your aggressive fat loss and fitness tracking app.

## Deploy to Vercel (5 minutes)

### Option A — Vercel CLI (fastest)
```bash
npm install -g vercel
cd fitelations
npm install
vercel
```
Follow the prompts. Done — you get a live URL.

### Option B — Vercel Dashboard (no CLI)
1. Go to [vercel.com](https://vercel.com) and sign up (free)
2. Click **Add New Project**
3. Upload this folder or connect a GitHub repo
4. Vercel auto-detects Vite — just click **Deploy**

### Option C — GitHub + Vercel (recommended for updates)
1. Create a GitHub repo and push this folder to it
2. Connect the repo to Vercel
3. Every push auto-deploys

## After Deploy

1. Open your Vercel URL on your phone
2. Go to **Settings → AI** tab and enter your API key:
   - **Anthropic**: get from [console.anthropic.com](https://console.anthropic.com)
   - **Gemini**: get from [aistudio.google.com](https://aistudio.google.com) (free tier available)
3. Tap **Save Settings** then **Test Connection**
4. Add to home screen:
   - **iPhone**: Share → Add to Home Screen
   - **Android**: three-dot menu → Add to Home Screen

## Voice Recording Note
Voice features use the Web Speech API. This requires:
- **HTTPS** (Vercel provides this automatically)
- **Microphone permission** — your browser will ask the first time
- Works on Chrome (Android) and Safari (iPhone)

## Local Development
```bash
npm install
npm run dev
```
Open http://localhost:5173

## Features
- 📷 AI food photo analysis (Anthropic or Gemini)
- 🎙 Voice food logging with full macro breakdown
- 🎙 Voice workout logging — just describe your session
- 🏋️ Lift tracker with automatic PR detection
- 🗺 GPS walk tracker with route map
- 💧 Hydration tracking (personalized to your weight)
- 📊 Cut Coach AI — adaptive calorie advice from your trends
- 🔴 Discipline Mode — zero tolerance accountability
- 💾 Export/import all data as JSON
