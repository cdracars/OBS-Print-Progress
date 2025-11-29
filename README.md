# OBS Print Progress Overlays

One browser-source scene per printer. Drop an HTML file into OBS, update the `PRINTER_CONFIG` block near the top, and you're set.

## Files
- `print-progress.css` - shared styling
- `print-progress.js` - shared logic (polls printer + updates overlays)
- `printer1.html`, `printer2.html` - example per-printer scenes (copy/rename for more printers)
- `bambu-proxy.py` - optional LAN bridge for Bambu printers (P1S/X1C)

Keep everything in the same folder.

## Configure a printer
### Klipper / Moonraker
Edit the `PRINTER_CONFIG` block in the HTML:
- `name`: Friendly printer name shown on the overlay
- `ip`: Printer API host (e.g., `printer1.local` or `192.168.x.x`)
- `camera`: Stream URL (e.g., `http://host/webcam/?action=stream`)
- `updateInterval`: Poll rate in ms (default 2000)
- `debug`: `true` to show debug info, `false` to hide

### Bambu P1S / X1C
The overlay can't talk MQTT directly from OBS, so use the included proxy to expose printer status over HTTP.

1) Enable LAN mode on the printer and note the **access code** and **serial**.
2) Install the proxy dependency once: `pip install paho-mqtt`
3) Run the proxy (example):  
   `python bambu-proxy.py --host 192.168.1.50 --serial PRINTER_SERIAL --access-code ACCESS_CODE --http-port 9876`
4) In the HTML set:
   - `type: 'bambu'`
   - `statusUrl: 'http://localhost:9876/status'` (port must match the proxy)
   - `ip`: printer IP/hostname (used for the camera URL)
   - `camera`: e.g., `rtsp://bblp:ACCESS_CODE@192.168.1.50:8554/live`
   - `updateInterval`/`debug` as needed

For multiple printers, run one proxy per printer on unique `--http-port` values (see `printer1.html`/`printer2.html` examples).

## Add another printer
1) Copy an existing HTML (e.g., `printer1.html` -> `newprinter.html`).
2) Update the `PRINTER_CONFIG` values in that new file.

## Use in OBS
1) Add a **Browser** source in OBS and point it to the HTML file on disk.
2) Set the source width/height you want; the overlay will scale to fit.
3) If the camera doesn't load, confirm the `camera` URL is reachable and supports browser playback (MJPEG/RTSP via OBS).

## Notes
- Debug info renders in a small block at the bottom; leave `debug: false` for clean output.
- If you move the folder, just repoint the Browser source(s) to the new path.
