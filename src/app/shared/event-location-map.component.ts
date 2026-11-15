import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { Geography, UpcomingHotelEvent } from '../core/network.models';
import { IconComponent } from './icon.component';
import { SpinnerComponent } from './spinner.component';
import { SkeletonComponent } from './skeleton.component';

type Point = [number, number];
interface MapFeature {
  kind: 'road' | 'water' | 'park';
  major?: boolean;
  name?: string;
  closed?: boolean;
  coordinates: Point[];
  segments?: Point[][];
}
interface MapData {
  cities: Record<
    string,
    { features: MapFeature[]; labels: { name: string; coordinates: Point }[] }
  >;
  countries: { name: string; polygons: Point[][][] }[];
}
interface MapView {
  x: number;
  y: number;
  scale: number;
}
interface MapMarker {
  id: string;
  name: string;
  city: string;
  kind: 'event' | 'hotel';
  coordinates: Geography;
  selected: boolean;
}

/** Offline geographic view. Streets are bundled OSM geometry, never invented or remote tiles. */
@Component({
  selector: 'app-event-location-map',
  imports: [IconComponent, SpinnerComponent, SkeletonComponent],
  templateUrl: './event-location-map.component.html',
  styleUrl: './event-location-map.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EventLocationMapComponent {
  readonly item = input.required<UpcomingHotelEvent>();
  readonly selectedHotelId = input<string | null>(null);
  readonly hotelSelected = output<string>();
  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('mapViewport');
  private readonly data = signal<MapData | null>(null);
  readonly loading = signal(true);
  readonly failed = signal(false);
  readonly size = signal({ width: 680, height: 300 });
  readonly view = signal<MapView>({ x: 0, y: 0, scale: 80 });
  readonly allLocations = signal(false);
  readonly markers = computed<MapMarker[]>(() => [
    {
      id: this.item().event.id,
      name: this.item().event.venue,
      city: this.item().event.city,
      kind: 'event',
      coordinates: this.item().event.coordinates,
      selected: true,
    },
    ...this.item().impacts.map((impact) => ({
      id: impact.hotelId,
      name: impact.hotel.name,
      city: impact.hotel.city,
      kind: 'hotel' as const,
      coordinates: impact.hotel.coordinates,
      selected: impact.hotelId === this.selectedHotelId(),
    })),
  ]);
  readonly distantCount = computed(
    () => this.item().impacts.filter((impact) => impact.distanceKm > 15).length,
  );
  readonly transform = computed(() => {
    const view = this.view();
    const size = this.size();
    return `translate(${size.width / 2 - view.x * view.scale} ${size.height / 2 - view.y * view.scale}) scale(${view.scale})`;
  });
  readonly cityPaths = computed(() => {
    const data = this.data();
    if (!data) return [];
    const cities = new Set(this.markers().map((marker) => marker.city.toLowerCase()));
    return [...cities].flatMap((city) =>
      (data.cities[city]?.features ?? []).map((feature) => ({
        ...feature,
        path: (feature.segments ?? [feature.coordinates])
          .map((segment) => this.path(segment, feature.closed))
          .join(' '),
      })),
    );
  });
  readonly countryPaths = computed(() =>
    (this.data()?.countries ?? []).map((country) => ({
      name: country.name,
      path: country.polygons
        .flatMap((polygon) => polygon.map((ring) => this.path(ring, true)))
        .join(' '),
    })),
  );
  readonly roadLabels = computed(() => {
    if (this.view().scale < 30) return [];
    const occupied: Point[] = [];
    const labels: { name: string; fullName: string; x: number; y: number }[] = [];
    const cities = new Set(this.markers().map((marker) => marker.city.toLowerCase()));
    const candidates = [...cities].flatMap((city) => this.data()?.cities[city]?.labels ?? []);
    for (const feature of candidates) {
      const coordinate = feature.coordinates;
      const position = this.screen({ longitude: coordinate[0], latitude: coordinate[1] });
      const { width, height } = this.size();
      if (position.x < 65 || position.x > width - 65 || position.y < 36 || position.y > height - 36)
        continue;
      if (
        occupied.some(([x, y]) => Math.abs(x - position.x) < 145 && Math.abs(y - position.y) < 45)
      )
        continue;
      if (
        this.markers().some((marker) => {
          const point = this.screen(marker.coordinates);
          return Math.abs(point.x - position.x) < 100 && Math.abs(point.y - position.y) < 45;
        })
      )
        continue;
      occupied.push([position.x, position.y]);
      const localName = feature.name.split(/\s[-/]\s|;/)[0].trim();
      const name = localName.length > 27 ? `${localName.slice(0, 26).trimEnd()}…` : localName;
      labels.push({ name, fullName: feature.name, ...position });
      if (labels.length >= 8) break;
    }
    return labels;
  });
  readonly scaleLabel = computed(() => {
    const km = 90 / this.view().scale;
    const value =
      [100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05].find((step) => step <= km) ?? 0.05;
    return {
      width: value * this.view().scale,
      label: value >= 1 ? `${value} km` : `${value * 1000} m`,
    };
  });
  private pointer: { id: number; x: number; y: number; view: MapView } | null = null;

  constructor() {
    const destroy = inject(DestroyRef);
    const controller = new AbortController();
    let observer: ResizeObserver | undefined;
    effect(() => {
      this.item();
      this.selectedHotelId();
      this.size();
      untracked(() => this.fit(false));
    });
    afterNextRender(() => {
      observer = new ResizeObserver(([entry]) => {
        if (destroy.destroyed) return;
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) this.size.set({ width, height });
      });
      observer.observe(this.viewport().nativeElement);
      void fetch('/maps/hotel-event-geography.json', { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error('Map asset unavailable');
          return response.json() as Promise<MapData>;
        })
        .then((data) => {
          if (!destroy.destroyed) this.data.set(data);
        })
        .catch((error: unknown) => {
          if (!destroy.destroyed && !(error instanceof DOMException && error.name === 'AbortError'))
            this.failed.set(true);
        })
        .finally(() => {
          if (!destroy.destroyed) this.loading.set(false);
        });
    });
    destroy.onDestroy(() => {
      controller.abort();
      observer?.disconnect();
    });
  }

  screen(coordinates: Geography): { x: number; y: number } {
    const [x, y] = this.project([coordinates.longitude, coordinates.latitude]);
    const view = this.view();
    const size = this.size();
    return {
      x: size.width / 2 + (x - view.x) * view.scale,
      y: size.height / 2 + (y - view.y) * view.scale,
    };
  }
  markerPosition(marker: MapMarker): { x: number; y: number } {
    const point = this.screen(marker.coordinates);
    const event = this.screen(this.item().event.coordinates);
    if (marker.kind === 'hotel' && Math.hypot(point.x - event.x, point.y - event.y) < 45) {
      return { x: point.x - 24, y: point.y + 32 };
    }
    return point;
  }
  markerVisible(marker: MapMarker): boolean {
    const point = this.markerPosition(marker);
    const { width, height } = this.size();
    return point.x >= 18 && point.x <= width - 18 && point.y >= 25 && point.y <= height - 24;
  }
  selectHotel(id: string): void {
    this.hotelSelected.emit(id);
  }
  fit(all = false): void {
    this.allLocations.set(all);
    const item = this.item();
    const selected = item.impacts.find((impact) => impact.hotelId === this.selectedHotelId());
    const nearest = [...item.impacts].sort((left, right) => left.distanceKm - right.distanceKm)[0];
    const local = selected ?? nearest;
    const impacts = all ? item.impacts : local ? [local] : [];
    const points = [
      item.event.coordinates,
      ...impacts.map((impact) => impact.hotel.coordinates),
    ].map((coordinates) => this.project([coordinates.longitude, coordinates.latitude]));
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const { width, height } = this.size();
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const closePair = Math.hypot(spanX, spanY) < 1;
    // Regional views can have a near-overlapping hotel displaced below the event pin.
    const verticalPadding = Math.max(spanX, spanY) > 15 ? 150 : 120;
    // Nearby venues need street-level framing, especially inside the compact Porto extract.
    const horizontalPadding = closePair ? Math.min(112, width * 0.42) : 112;
    const scale = Math.min(
      (width - horizontalPadding) / Math.max(spanX, closePair ? 0.35 : 1.5),
      (height - verticalPadding) / Math.max(spanY, closePair ? 0.3 : 1.1),
    );
    this.view.set({
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      scale: Math.max(0.2, Math.min(800, scale)),
    });
  }
  zoom(direction: number): void {
    this.view.update((view) => ({
      ...view,
      scale: Math.max(0.2, Math.min(1000, view.scale * (direction > 0 ? 1.5 : 1 / 1.5))),
    }));
  }
  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || (event.target as Element).closest('button, a')) return;
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, view: this.view() };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  onPointerMove(event: PointerEvent): void {
    const pointer = this.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    this.view.set({
      ...pointer.view,
      x: pointer.view.x - (event.clientX - pointer.x) / pointer.view.scale,
      y: pointer.view.y - (event.clientY - pointer.y) / pointer.view.scale,
    });
  }
  onPointerEnd(): void {
    this.pointer = null;
  }
  onKeydown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    const shifts: Record<string, Point> = {
      ArrowLeft: [-45, 0],
      ArrowRight: [45, 0],
      ArrowUp: [0, -45],
      ArrowDown: [0, 45],
    };
    if (shifts[event.key]) {
      event.preventDefault();
      const [x, y] = shifts[event.key];
      this.view.update((view) => ({
        ...view,
        x: view.x + x / view.scale,
        y: view.y + y / view.scale,
      }));
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      this.zoom(1);
    } else if (event.key === '-') {
      event.preventDefault();
      this.zoom(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.fit(this.allLocations());
    }
  }
  private project([longitude, latitude]: Point): Point {
    const origin = this.item().event.coordinates;
    return [
      (longitude - origin.longitude) * 111.195 * Math.cos((origin.latitude * Math.PI) / 180),
      -(latitude - origin.latitude) * 111.195,
    ];
  }
  private path(coordinates: Point[], closed = false): string {
    return (
      coordinates
        .map((coordinate, index) => {
          const [x, y] = this.project(coordinate);
          return `${index ? 'L' : 'M'}${x.toFixed(4)},${y.toFixed(4)}`;
        })
        .join('') + (closed ? 'Z' : '')
    );
  }
}
