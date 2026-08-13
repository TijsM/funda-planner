'use client';

import { useEditor, ed } from '@state/store';

export function Toasts() {
  const toasts = useEditor(s => s.toasts);
  return (
    <div className="toasts" id="toasts">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind ?? ''}`} onClick={() => ed().dismissToast(t.id)}>
          <i /><span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
