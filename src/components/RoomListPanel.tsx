import { useMemo, useState } from "react";
import type { Room } from "../types";

function norm(s: string) {
  return s.trim().toLowerCase();
}

export function RoomListPanel(props: {
  rooms: Room[];
  selectedRoomId: string | null;
  onSelectRoom: (id: string) => void;
  onOpenDetails: (id: string) => void;
}) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const query = norm(q);
    const list = props.rooms.slice();

    // tri stable: d'abord celles sans polygone, puis par numero
    list.sort((a, b) => {
      const aNo = !a.polygon || (Array.isArray(a.polygon) && a.polygon.length < 3);
      const bNo = !b.polygon || (Array.isArray(b.polygon) && b.polygon.length < 3);
      if (aNo !== bNo) return aNo ? -1 : 1;
      return (a.numero || "").localeCompare(b.numero || "", "fr");
    });

    if (!query) return list;

    return list.filter(r => {
      const hay = [
        r.numero ?? "",
        r.designation ?? "",
        r.service ?? "",
        r.niveau ?? "",
        r.aile ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(query);
    });
  }, [props.rooms, q]);


  const missingCount = useMemo(() => {
    return props.rooms.filter(r => !r.polygon || (Array.isArray(r.polygon) && r.polygon.length < 3)).length;
  }, [props.rooms]);

  const totalCount = props.rooms.length;

  return (
    <div className="room-panel">
      <div className="room-panel-header">
        <div className="room-panel-title">
          Pièces <span className="room-panel-count">{totalCount}</span>
        </div>
        <div className="room-panel-meta">{missingCount} sans polygone</div>
      </div>

      <input
        className="room-panel-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Rechercher (numéro, service, désignation...)"
      />

      <div className="room-panel-list">
        {filtered.map((r) => {
          const selected = r.id === props.selectedRoomId;
          const hasPoly = !!r.polygon && (r.polygon as any[]).length >= 3;
          const descriptionParts = [
            r.service ? r.service : "—",
            r.designation ? r.designation : "—",
            r.surface != null ? `${r.surface} m²` : "",
          ].filter(Boolean);

          return (
            <div
              key={r.id}
              onClick={() => props.onSelectRoom(r.id)}
              onDoubleClick={() => props.onOpenDetails(r.id)}
              className={`room-panel-item ${selected ? "room-panel-item--active" : ""}`}
            >
              <div className="room-panel-item-main">
                <div className="room-panel-item-title">
                  <span className="room-panel-item-number">{r.numero}</span>
                  <span className={`room-panel-status ${hasPoly ? "room-panel-status--ready" : "room-panel-status--missing"}`}>
                    {hasPoly ? "Cartographiée" : "A dessiner"}
                  </span>
                </div>

                <div className="room-panel-muted room-panel-item-desc">
                  {descriptionParts.join(" · ")}
                </div>
              </div>

            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="room-panel-empty room-panel-muted">Aucun résultat.</div>
        )}
      </div>
    </div>
  );
}
