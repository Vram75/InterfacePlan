import { useMemo, useState } from "react";
import type { Room } from "../types";

function norm(s: string) {
  return s.trim().toLowerCase();
}

export function RoomListPanel(props: {
  rooms: Room[];
  selectedRoomId: string | null;
  onSelectRoom: (id: string) => void;
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

  return (
    <div style={{ padding: 12, borderBottom: "1px solid #eee" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontWeight: 800 }}>Pièces</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          {missingCount} sans polygone
        </div>
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Rechercher (numéro, service, désignation...)"
        style={{ width: "100%", marginTop: 8, padding: 8 }}
      />

      <div style={{ marginTop: 10, maxHeight: 300, overflow: "auto", border: "1px solid #eee" }}>
        {filtered.map((r) => {
          const selected = r.id === props.selectedRoomId;
          const hasPoly = !!r.polygon && (r.polygon as any[]).length >= 3;

          return (
            <div
              key={r.id}
              onClick={() => props.onSelectRoom(r.id)}
              style={{
                padding: "8px 10px",
                cursor: "pointer",
                borderBottom: "1px solid #f2f2f2",
                background: selected ? "#f6f6f6" : "transparent",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 8,
                alignItems: "center",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ fontWeight: 700 }}>{r.numero}</span>
                  {!hasPoly && (
                    <span style={{ fontSize: 12, opacity: 0.75 }}>
                      (sans polygone)
                    </span>
                  )}
                </div>

                <div style={{ fontSize: 12, opacity: 0.8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.service ? r.service : "—"} · {r.designation ? r.designation : "—"}
                </div>
              </div>

              <div style={{ fontSize: 12, opacity: 0.7 }}>
                {r.surface != null ? `${r.surface} m²` : ""}
              </div>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div style={{ padding: 10, opacity: 0.7 }}>Aucun résultat.</div>
        )}
      </div>
    </div>
  );
}
