import { useState } from 'react';

const COLOR_SAMPLES: { label: string; color: string; desc: string }[] = [
  { label: '🟡 Gold',      color: '#f59e0b', desc: 'Entry / Root node' },
  { label: '🔵 Cyan',      color: '#61dafb', desc: 'Normal intent node' },
  { label: '🟢 Green',     color: '#10b981', desc: 'DTMF / digit method' },
  { label: '🔴 Rose',      color: '#f43f5e', desc: 'No-input (noh) edge' },
  { label: '🟠 Orange',    color: '#f59e0b', desc: 'Follow-up edge' },
  { label: '🔵 Blue',      color: '#3b82f6', desc: 'Redirect edge' },
  { label: '🟣 Purple',    color: '#8b5cf6', desc: 'Procedure arg edge' },
  { label: '⬜ Grey',      color: '#94a3b8', desc: 'Mirror node' },
  { label: '⭕ Ring',      color: '#888',    desc: 'Collapsible (has children)' },
];

export default function LegendPanel() {
  const [open, setOpen] = useState(true);

  return (
    <div style={{
      position: 'absolute',
      top: 12,
      right: 12,
      zIndex: 100,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: 12,
      color: '#ccc',
      background: 'rgba(13, 17, 23, 0.88)',
      border: '1px solid #333',
      borderRadius: 8,
      padding: open ? '10px 14px' : '6px 10px',
      minWidth: open ? 180 : 40,
      backdropFilter: 'blur(6px)',
      userSelect: 'none',
    }}>
      <div
        onClick={() => setOpen(!open)}
        style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13, color: '#eee', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span>{open ? '▾' : '▸'}</span> Legend
      </div>

      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontWeight: 500, color: '#888', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginTop: 4 }}>Nodes</div>
          {COLOR_SAMPLES.filter((s) => s.label.includes('Gold') || s.label.includes('Cyan') || s.label.includes('Grey') || s.label.includes('Ring')).map((s) => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: s.color === '#888' ? 'none' : s.color,
                border: s.color === '#888' ? '2px solid #888' : 'none',
                flexShrink: 0,
              }} />
              <span>{s.desc}</span>
            </div>
          ))}

          <div style={{ fontWeight: 500, color: '#888', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginTop: 8 }}>Edges</div>
          {COLOR_SAMPLES.filter((s) => !s.label.includes('Gold') && !s.label.includes('Cyan') && !s.label.includes('Grey') && !s.label.includes('Ring')).map((s) => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                display: 'inline-block',
                width: 16,
                height: 2.5,
                borderRadius: 1,
                background: s.color,
                flexShrink: 0,
              }} />
              <span>{s.desc}</span>
            </div>
          ))}

          <div style={{ marginTop: 8, fontSize: 10, color: '#666', borderTop: '1px solid #222', paddingTop: 6 }}>
            Click node → expand/collapse children
            <br />
            Drag to rotate · Scroll to zoom
          </div>
        </div>
      )}
    </div>
  );
}
