# Offline event map

`hotel-event-geography.json` contains real geographic basemap geometry, bundled locally.
The map makes no runtime requests to tile, geocoding, or third-party map services.
The fictional hotel and event positions remain in the canonical hotel-network fixtures.

## Street, park and water geometry

© OpenStreetMap contributors, retrieved 14 November 2026 through the Overpass API
(Brussels, Amsterdam and Berlin) and the OpenStreetMap map API (Porto).
The city extracts and their simplified derivative geometry are provided under the
[Open Data Commons Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Attribution and source information: [OpenStreetMap copyright](https://www.openstreetmap.org/copyright).
The unencrypted JSON asset is the machine-readable derivative database.

Each extract uses this Overpass query, with the bounding box substituted:

```text
[out:json][timeout:90];
(
  way["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$"](S,W,N,E);
  way["waterway"~"^(river|canal)$"](S,W,N,E);
  way["natural"="water"](S,W,N,E);
  way["leisure"="park"](S,W,N,E);
);
out geom;
```

| Extract   | South  | West   | North  | East   |
| --------- | ------ | ------ | ------ | ------ |
| Brussels  | 50.82  | 4.32   | 50.88  | 4.40   |
| Amsterdam | 52.34  | 4.85   | 52.41  | 4.95   |
| Berlin    | 52.49  | 13.35  | 52.55  | 13.47  |
| Porto     | 41.137 | -8.625 | 41.149 | -8.603 |

Porto uses `https://api.openstreetmap.org/api/0.6/map?bbox=-8.625,41.137,-8.603,41.149`;
ways are filtered to the same tags and their node geometry converted to the
same intermediate format. It is a smaller central extract after Overpass returned
an upstream error for that query.

Only ways with actual geometry are retained. Curves are simplified by roughly
5–7 metres and coordinates rounded to five decimal places. Rendering groups ways
into shared paths; no roads are generated or invented. Open river/canal ways show
their centerline with a cartographic stroke, not measured river width. Closed
water polygons and parks retain their actual area geometry. Street labels come
from named primary, secondary and tertiary ways. Completeness is limited to the
four city extracts; this is not a street navigation or routing map.

## Regional context

Country boundaries are an independent, public-domain Natural Earth 1:50m dataset,
from [Natural Earth's maintained vector repository](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_50m_admin_0_countries.geojson).
[Natural Earth terms](https://www.naturalearthdata.com/about/terms-of-use/).
The eight-country subset gives regional context when showing the shared
Brussels/Amsterdam event. It is displayed at region scale only.

The geographic projection is north-up local equirectangular, centered on the
event latitude. The separately displayed hotel-event distances are the canonical
Haversine straight-line distances, not travel distances.

## Rebuilding

Download the four Overpass responses to `juyo-osm-{city}.json` and the eight-country
Natural Earth feature collection to `juyo-map-region.json` in an input directory.
Then run `python3 scripts/export-offline-map.py /path/to/input-directory`.
Normal fixture export and application startup do not download or regenerate map data.
