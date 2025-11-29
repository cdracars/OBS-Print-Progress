#!/usr/bin/env python3
"""
Lightweight LAN proxy for Bambu printers (P1S / X1C).

Runs an HTTP endpoint that the OBS overlay can poll while it keeps a LAN MQTT
connection open to the printer. Requires LAN mode + access code.
"""

import argparse
import json
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import paho.mqtt.client as mqtt


GET_VERSION = {"info": {"sequence_id": "0", "command": "get_version"}}
PUSH_ALL = {"pushing": {"sequence_id": "0", "command": "pushall"}}
START_PUSH = {"pushing": {"sequence_id": "0", "command": "start"}}


def parse_args():
    parser = argparse.ArgumentParser(description="Expose Bambu printer status over HTTP for OBS overlays.")
    parser.add_argument("--host", required=True, help="Printer hostname/IP")
    parser.add_argument("--serial", required=True, help="Printer serial (used in MQTT topics)")
    parser.add_argument("--access-code", required=True, help="LAN access code from the printer")
    parser.add_argument("--http-port", type=int, default=9876, help="Port to serve /status on (default: 9876)")
    parser.add_argument("--http-host", default="127.0.0.1", help="Bind address for the HTTP server (default: 127.0.0.1)")
    parser.add_argument("--allow-origin", default="*", help="CORS allow-origin value (default: *)")
    parser.add_argument("--mqtt-port", type=int, default=8883, help="MQTT port (default: 8883)")
    parser.add_argument("--verify-tls", action="store_true", help="Verify the printer TLS certificate (default: disabled/self-signed)")
    return parser.parse_args()


class SharedState:
    def __init__(self):
        self._lock = threading.Lock()
        self._data = {
            "print": {},
            "device": {},
            "last_update": None,
            "last_error": None,
            "last_payload_keys": [],
        }

    def update_from_payload(self, payload):
        data = payload.get("pushing") or payload
        if not isinstance(data, dict):
            return

        with self._lock:
            if isinstance(data.get("print"), dict):
                self._data["print"].update(data["print"])
            if isinstance(data.get("device"), dict):
                self._data["device"].update(data["device"])

            self._data["last_update"] = time.time()
            self._data["last_payload_keys"] = list(data.keys())

    def set_error(self, message):
        with self._lock:
            self._data["last_error"] = message

    def snapshot(self):
        with self._lock:
            return dict(self._data)


def build_mqtt_client(args, state: SharedState):
    client = mqtt.Client(client_id=f"obs-overlay-{args.serial}", clean_session=True)
    client.username_pw_set("bblp", password=args.access_code)
    if args.verify_tls:
        client.tls_set()
        client.tls_insecure_set(False)
    else:
        client.tls_set(cert_reqs=ssl.CERT_NONE)
        client.tls_insecure_set(True)

    topic_report = f"device/{args.serial}/report"
    topic_request = f"device/{args.serial}/request"

    def on_connect(mqtt_client, _userdata, _flags, rc):
        if rc != 0:
            state.set_error(f"MQTT connect failed with rc={rc}")
            return
        mqtt_client.subscribe(topic_report)
        for msg in (GET_VERSION, PUSH_ALL, START_PUSH):
            mqtt_client.publish(topic_request, json.dumps(msg))

    def on_message(_client, _userdata, msg):
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
        except Exception as exc:
            state.set_error(f"Decode error: {exc}")
            return
        state.update_from_payload(payload)

    client.on_connect = on_connect
    client.on_message = on_message
    return client


def start_http_server(args, state: SharedState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # Quiet the default HTTP logs.
            return

        def _send_json(self, obj, status=200):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", args.allow_origin)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path not in ("/status", "/status.json"):
                self._send_json({"ok": False, "error": "not found"}, status=404)
                return

            snapshot = state.snapshot()
            self._send_json(
                {
                    "ok": True,
                    "data": snapshot,
                }
            )

    server = ThreadingHTTPServer((args.http_host, args.http_port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main():
    args = parse_args()
    state = SharedState()

    http_server = start_http_server(args, state)
    client = build_mqtt_client(args, state)

    client.connect(args.host, args.mqtt_port, keepalive=15)
    client.loop_start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()
        http_server.shutdown()


if __name__ == "__main__":
    main()
