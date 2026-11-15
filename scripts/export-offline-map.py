"""Build the bundled geographic asset from downloaded Overpass + Natural Earth files.

Usage: python3 scripts/export-offline-map.py /tmp
Expected files: juyo-osm-{brussels,amsterdam,berlin,porto}.json and juyo-map-region.json.
Source queries, bounds, and licences are documented in public/maps/README.md.
This script is deliberately separate from the normal fixture exporter and never runs at app startup.
"""

import collections
import json
import math
import pathlib
import sys

BOUNDS = {
    'brussels': (4.32, 50.82, 4.40, 50.88),
    'amsterdam': (4.85, 52.34, 4.95, 52.41),
    'berlin': (13.35, 52.49, 13.47, 52.55),
    'porto': (-8.625, 41.137, -8.603, 41.149),
}


def clip_line(points, bounds):
    west, south, east, north = bounds
    segments, current = [], []
    for first, last in zip(points, points[1:]):
        dx, dy = last[0] - first[0], last[1] - first[1]
        lower, upper, visible = 0.0, 1.0, True
        for p, q in zip((-dx, dx, -dy, dy), (first[0] - west, east - first[0], first[1] - south, north - first[1])):
            if p == 0:
                if q < 0:
                    visible = False
                    break
            elif p < 0:
                lower = max(lower, q / p)
            else:
                upper = min(upper, q / p)
        if visible and lower <= upper:
            start = [round(first[0] + lower * dx, 5), round(first[1] + lower * dy, 5)]
            end = [round(first[0] + upper * dx, 5), round(first[1] + upper * dy, 5)]
            if current and current[-1] == start:
                current.append(end)
            else:
                if len(current) > 1:
                    segments.append(current)
                current = [start, end]
        else:
            if len(current) > 1:
                segments.append(current)
            current = []
    if len(current) > 1:
        segments.append(current)
    return segments


def clip_polygon(points, bounds):
    west, south, east, north = bounds
    ring = points[:-1] if points[0] == points[-1] else points
    for axis, boundary, positive in [(0, west, True), (0, east, False), (1, south, True), (1, north, False)]:
        if not ring:
            return []
        output = []
        previous = ring[-1]
        previous_inside = previous[axis] >= boundary if positive else previous[axis] <= boundary
        for point in ring:
            inside = point[axis] >= boundary if positive else point[axis] <= boundary
            if inside != previous_inside:
                ratio = (boundary - previous[axis]) / (point[axis] - previous[axis])
                output.append([round(previous[0] + ratio * (point[0] - previous[0]), 5), round(previous[1] + ratio * (point[1] - previous[1]), 5)])
            if inside:
                output.append(point)
            previous, previous_inside = point, inside
        ring = output
    return [ring + [ring[0]]] if len(ring) > 2 else []


def simplify(points, tolerance=0.00006):
    """Keep real turns while removing redundant points (roughly 5–7 metres)."""
    if len(points) <= 2:
        return points
    first, last = points[0], points[-1]
    dx, dy = last[0] - first[0], last[1] - first[1]
    denominator = dx * dx + dy * dy
    best, index = 0, 0
    for i, point in enumerate(points[1:-1], 1):
        t = max(0, min(1, ((point[0] - first[0]) * dx + (point[1] - first[1]) * dy) / denominator)) if denominator else 0
        distance = math.hypot(point[0] - first[0] - t * dx, point[1] - first[1] - t * dy)
        if distance > best:
            best, index = distance, i
    if best > tolerance:
        return simplify(points[: index + 1], tolerance)[:-1] + simplify(points[index:], tolerance)
    return [first, last]


def export_city(source, bounds):
    layers = collections.defaultdict(list)
    label_candidates = {}
    seen = set()
    for element in source['elements']:
        if element['id'] in seen:
            continue
        seen.add(element['id'])
        tags = element.get('tags', {})
        points = [[round(point['lon'], 5), round(point['lat'], 5)] for point in element.get('geometry', [])]
        if len(points) < 2:
            continue
        closed = points[0] == points[-1]
        if tags.get('highway'):
            major = tags['highway'] in ('primary', 'secondary', 'tertiary')
            key = ('road', major, False)
            points = simplify(points)
            name = tags.get('name')
            if major and name:
                length = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
                if length > label_candidates.get(name, (0, []))[0]:
                    label_candidates[name] = (length, points[len(points) // 2])
        elif tags.get('waterway') or tags.get('natural') == 'water':
            key = ('water', False, closed)
            points = simplify(points, 0.00004)
        elif tags.get('leisure') == 'park' and closed:
            key = ('park', False, True)
            points = simplify(points, 0.00005)
        else:
            continue
        if key[2] and len(points) < 4:
            continue
        clipped = clip_polygon(points, bounds) if key[2] else clip_line(points, bounds)
        layers[key].extend(clipped)
    features = [
        {'kind': kind, 'major': major, 'closed': closed, 'coordinates': [], 'segments': segments}
        for (kind, major, closed), segments in layers.items()
    ]
    labels = [
        {'name': name, 'coordinates': point}
        for name, (_, point) in sorted(label_candidates.items(), key=lambda item: item[1][0], reverse=True)[:100]
    ]
    return {'features': features, 'labels': labels}


source_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp')
root = pathlib.Path(__file__).resolve().parents[1]
cities = {
    city: export_city(json.loads((source_dir / f'juyo-osm-{city}.json').read_text()), BOUNDS[city])
    for city in ['brussels', 'amsterdam', 'berlin', 'porto']
}
region = json.loads((source_dir / 'juyo-map-region.json').read_text())
countries = []
for feature in region['features']:
    geometry = feature['geometry']
    polygons = geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]
    countries.append({'name': feature['properties']['name'], 'polygons': polygons})
data = {
    'attribution': '© OpenStreetMap contributors; Natural Earth',
    'osmLicense': 'https://opendatacommons.org/licenses/odbl/1-0/',
    'osmSources': ['https://overpass-api.de/api/interpreter', 'https://api.openstreetmap.org/api/0.6/map'],
    'naturalEarthSource': 'https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_50m_admin_0_countries.geojson',
    'retrievedOn': '2026-11-14',
    'cities': cities,
    'countries': countries,
}
destination = root / 'public/maps/hotel-event-geography.json'
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
print(f'Exported {destination.name}: {destination.stat().st_size:,} bytes, {len(cities)} city extracts.')
