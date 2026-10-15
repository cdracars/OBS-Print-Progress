"""Translate a normalized printer state into Moonraker API responses.

Adapters for non-Klipper printers fill in a `normalized` dict (see
`empty_state`). The overlays only speak Moonraker, so this module renders
that state as the Moonraker objects they query: print_stats,
virtual_sdcard, display_status, extruder, heater_bed, toolhead and an
optional `temperature_sensor chamber`.
"""

import time
from urllib.parse import unquote

STATES = ('standby', 'printing', 'paused', 'complete', 'cancelled', 'error')


def empty_state():
    return {
        'online': False,
        'message': 'Connecting...',
        'state': 'standby',
        'filename': '',
        'progress': 0.0,          # 0..1
        'elapsed': None,          # seconds
        'remaining': None,        # seconds
        'layer': None,            # 1-based current layer
        'total_layers': None,
        'nozzle': None, 'nozzle_target': None,
        'bed': None, 'bed_target': None,
        'chamber': None, 'chamber_target': None,
        'bed_size': (256, 256),
        'file_size': 0,
    }


def _num(v, default=0.0):
    try:
        f = float(v)
        return f if f == f else default  # NaN check
    except (TypeError, ValueError):
        return default


def moonraker_objects(n):
    """Render normalized state as Moonraker printer objects."""
    elapsed = n.get('elapsed')
    progress = max(0.0, min(1.0, _num(n.get('progress'))))
    bx, by = n.get('bed_size') or (256, 256)
    objs = {
        'print_stats': {
            'state': n.get('state') or 'standby',
            'filename': n.get('filename') or '',
            'print_duration': _num(elapsed),
            'total_duration': _num(elapsed),
            'message': '' if n.get('online') else (n.get('message') or ''),
            'info': {
                'current_layer': n.get('layer'),
                'total_layer': n.get('total_layers'),
            },
        },
        'virtual_sdcard': {
            'progress': progress,
            'is_active': n.get('state') == 'printing',
            'file_size': int(_num(n.get('file_size'))),
        },
        'display_status': {'progress': progress, 'message': None},
        'extruder': {'temperature': _num(n.get('nozzle')), 'target': _num(n.get('nozzle_target'))},
        'heater_bed': {'temperature': _num(n.get('bed')), 'target': _num(n.get('bed_target'))},
        'toolhead': {'axis_minimum': [0, 0, 0, 0], 'axis_maximum': [bx, by, 250, 0]},
    }
    if n.get('chamber') is not None:
        chamber = {'temperature': _num(n.get('chamber'))}
        if n.get('chamber_target') is not None:
            chamber['target'] = _num(n.get('chamber_target'))
        objs['temperature_sensor chamber'] = chamber
    return objs


def parse_object_query(query):
    """'print_stats&temperature_sensor%20chamber=temperature' -> object names."""
    names = []
    for part in (query or '').split('&'):
        if not part:
            continue
        name = unquote(part.split('=', 1)[0].replace('+', ' '))
        if name:
            names.append(name)
    return names


def query_response(n, query):
    objs = moonraker_objects(n)
    wanted = parse_object_query(query)
    status = {k: objs[k] for k in wanted if k in objs} if wanted else objs
    return {'result': {'eventtime': time.time(), 'status': status}}


def list_response(n):
    return {'result': {'objects': list(moonraker_objects(n).keys())}}


def metadata_response(n, filename):
    total = None
    if n.get('elapsed') is not None and n.get('remaining') is not None:
        total = _num(n['elapsed']) + _num(n['remaining'])
    meta = {'filename': filename}
    if total:
        meta['estimated_time'] = round(total)
    if n.get('total_layers'):
        meta['layer_count'] = n['total_layers']
    return {'result': meta}


def estimate_elapsed(progress, remaining):
    """Elapsed time consistent with a progress fraction and remaining time.

    Chosen so the overlay's own progress-based "remaining" estimate
    (elapsed / progress - elapsed) equals the printer's reported remaining.
    """
    if remaining is None or not (0 < progress < 1):
        return None
    return remaining * progress / (1 - progress)
