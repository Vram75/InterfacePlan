export type Point = { x: number; y: number };

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

  page: number;
  polygon?: Point[] | null;
};

export type ServiceColor = { id: string; service: string; color: string };
