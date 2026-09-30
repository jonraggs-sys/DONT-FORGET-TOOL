# DON'T FORGET

A talking video journal. You open it, and it opens on **today**.

## What it does

1. **Mic first, nothing else.** The first screen is black with one button. It asks for your microphone and nothing else.
2. **The "before the mission" scene.** A command-center intro with a moving grid floor, five colored light beams, and a talking orb. A voice says hi and explains what it's for. Then the scene fades away and the voice walks you through the journal, lighting up each part as it names it: the camera, the transcript, the calendar, the free-write box, the assistant, and the switch that turns the assistant off.
3. **The journal**, a mix of the apps you already know:
   - **Stories row** (Instagram): your last 14 days as rings. Tap one to jump to that day.
   - **Camera + LIVE badge + timer** (Twitch/YouTube): record a video diary. It's **transcribed live** while you talk.
   - **Upload**: add a video from your phone or computer to whatever day you're looking at.
   - **Free write** (Facebook's "What's on your mind?"): just type and let it go.
   - **Day feed** (Reddit/Instagram posts): everything from that day, with ♥ favorites.
   - **Assistant chat** (Twitch chat): type, or tap 🎙 and talk. It talks back.
   - **Calendar**: dots for the days you logged, tinted by mood.
   - **Your patterns**: streak, days logged, a 14-day mood bar chart, and the words *you* use most.
   - **Rewind** (TikTok/Reels): a full-screen vertical scroll through every video you've recorded.

## Personalized, in your language

- **Your language.** The whole experience follows your browser language: the words on screen, the voice, and the speech-to-text. You can switch it in the top bar. English, Español, Português and Français are built in, and adding one means adding a block to `app/js/i18n.js`.
- **Your way of talking.** The assistant learns from your own entries. It picks up the words you repeat, whether you talk casually ("lol", "bro", "ngl") or more plainly, and your mood over time. Its replies mirror that: casual if you're casual, plain if you're plain, and it brings your own words back to you ("You've said 'gym' a lot lately — what's going on there?").
- **Welcome back.** On return visits the intro is short and personal: your name, your streak, and what you were talking about last time.

## Talk to the assistant

Try: `what's up` · `recap today` · `yesterday` · `this week` · `how am I growing` · `what did I say about ___` · `call me ___` · `be quiet`

You can also turn it off with the switch. Your camera, transcript, calendar and journal all keep working without it.

## Privacy

Everything stays on your device. Videos, transcripts, notes and the assistant's memory are stored in your browser's IndexedDB, and nothing is uploaded to a server. (Live transcription uses the browser's own speech service. In Chrome, that audio goes through Google's speech servers.)

## Run it

It's plain HTML/CSS/JS with no build step and no install.

```bash
# from the repo root
python3 -m http.server 8080
# or: npx serve .
```

Then open **http://localhost:8080**.

Camera and mic only work on `localhost` or `https://`. To put it online for free, turn on **GitHub Pages** for this repo (Settings → Pages → deploy from branch, root folder) and it will be served over https.

**Best in Chrome or Edge.** They support live transcription. Safari and Firefox can still record, upload, free-write and chat, but won't transcribe while you talk.

## Files

```
index.html          the page: mic gate, intro scene, journal, rewind
app/css/styles.css  the look
app/js/app.js       wires everything together
app/js/intro.js     the cinematic intro + guided tour
app/js/voice.js     speaking, listening, mic level meter
app/js/brain.js     the local assistant: learns your words, tone, mood, streak
app/js/i18n.js      every string, per language
app/js/db.js        on-device storage (IndexedDB)
HQ.txt              earlier HQ task-dashboard prototype (React + Firebase)
```
