"""OBS Print Progress local bridge.

Lets the browser overlays talk to printers that a web page can't reach
directly (Bambu Lab MQTT/TLS, Elegoo SDCP) by presenting every printer as a
Moonraker-compatible HTTP API under /p/<printer-id>/. Klipper/Moonraker
printers are proxied as-is, which also removes the need for CORS setup.

Python standard library only - nothing to pip install.
"""
