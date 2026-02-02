export type Point = { x: number; y: number };

export type RoomPolygonEntry = {
  page: number;         // 0-based
  polygon: Point[];     // normalized 0..1
  locked?: boolean;     // optional: lock editing on this page
};

export type Room = {
  id: string;
  numero: string;

  niveau?: string | null;
  aile?: string | null;
  designation?: string | null;

  service?: string | null;
  surface?: number | null;

  personneNom?: string | null;
  personneTel?: string | null;

  photoUrl?: string | null;

  // Legacy (repo actuel)
  page: number;                 // 0-based
  polygon?: Point[] | null;     // normalized 0..1

  // ✅ Nouveau (multi-pages, rétro-compatible)
  polygons?: RoomPolygonEntry[] | null;
};

export type ServiceColor = { service: string; color: string };
