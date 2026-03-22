# WiGLE Visualizer

A static, client-side web app for loading WiGLE-compatible CSV files and replaying wireless observations over time on a map.

## What it does

- Loads CSV files from your machine (no backend upload).
- Parses observations in a Web Worker to keep the UI responsive.
- Plays route history with pause, scrub, speed control, and stepping.
- Shows estimated network locations with confidence levels.
- Supports Wi-Fi, Bluetooth, and cellular layer toggles.

## Try it online

You can try the hosted build here:

https://zeroone3010.github.io/wigle-visualizer/

## Run locally

Because this app uses a Web Worker, serve the folder over HTTP (instead of opening `index.html` directly as a `file://` URL). For example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.
