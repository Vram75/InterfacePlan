import type { Room } from "./types";

const BASE = "http://localhost:8000";

async function mustJson<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export const api = {
  async getRooms(): Promise<Room[]> {
    const r = await fetch(`${BASE}/api/rooms`);
    return mustJson<Room[]>(r);
  },

  async updateRoom(room: Room): Promise<Room> {
    const r = await fetch(`${BASE}/api/rooms/${room.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(room),
    });
    return mustJson<Room>(r);
  },

  async updatePolygon(roomId: string, payload: { page: number; polygon: any[] }): Promise<Room> {
    const r = await fetch(`${BASE}/api/rooms/${roomId}/polygon`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return mustJson<Room>(r);
  },

  async uploadPhoto(roomId: string, file: File): Promise<Room> {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`${BASE}/api/rooms/${roomId}/photo`, {
      method: "POST",
      body: fd,
    });
    return mustJson<Room>(r);
  },
};
