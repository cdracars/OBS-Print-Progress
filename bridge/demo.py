"""Explicitly simulated workshop. Never opens a printer connection."""
import time
from .base import Adapter
from .dashboard import Dashboard


class SimulatedPrinter(Adapter):
    def perform_command(self, action):
        self.update(state={'pause': 'paused', 'resume': 'printing', 'cancel': 'cancelled'}[action])


class DemoFleet:
    def __init__(self, path):
        self.dashboard = Dashboard(path)
        entries = [('hos', 'Hoss', 'klipper', 'printing', 'enclosure_front_panel.gcode', .64, 219, 60),
                   ('sam', 'Sam', 'klipper', 'printing', 'gridfinity_drawer_set.gcode', .32, 210, 60),
                   ('pibeta', 'pibeta', 'klipper', 'standby', '', None, 24, 24),
                   ('eighttrack', 'EightTrack', 'klipper', 'paused', 'cable_guide_v3.gcode', .47, 205, 55),
                   ('lucee', 'Lucee', 'elegoo-cc', 'printing', 'modular_spool_holder.gcode', .82, 235, 75),
                   ('mini', 'Prusa MINI', 'prusalink', 'complete', 'benchy.gcode', 1, 27, 28),
                   ('saturn', 'Saturn 4 Ultra', 'elegoo-resin', 'printing', 'miniatures_plate_04.goo', .55, None, None),
                   ('photon', 'Photon P1', 'anycubic-p1', 'standby', '', None, None, None)]
        self.configs, self.adapters = [], {}
        for alias, name, kind, state, filename, progress, nozzle, bed in entries:
            cfg = {'id': alias, 'name': name, 'type': kind, 'ip': '', 'updateInterval': 5000}
            ad = SimulatedPrinter(cfg)
            ad.update(online=True, message='', state=state, filename=filename, progress=progress,
                      nozzle=nozzle, bed=bed, chamber=29 if 'resin' in kind else None,
                      remaining=3600*(1-progress) if progress else None, elapsed=3600*progress if progress else None,
                      layer=round(progress*240) if progress else None, total_layers=240 if progress else None)
            self.configs.append(cfg)
            self.adapters[alias] = ad
        self.dashboard.sync(self.configs)
        for item in self.dashboard.items():
            self.dashboard.update_item(item['ci_id'], {'owner': 'Demo operator', 'location': 'Simulated workshop',
                                                     'evidence': 'Simulated printer; no physical qualification.'})
            self.dashboard.enable_controls(item['ci_id'], True)

    def tick(self):
        # A valid simulated observation. This never reads or writes real equipment.
        for ad in self.adapters.values():
            with ad.lock:
                ad.observed_at = time.time()
