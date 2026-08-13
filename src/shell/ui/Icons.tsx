/** Icon sprite, lifted from the single-file build. One <symbol> per icon so a
 *  <use> scales it — without the viewBox they render cropped, not resized. */
export function IconSprite() {
  return (
    <svg style={{ display: 'none' }} aria-hidden="true">
      <defs>
        <symbol id="i-sel" viewBox="0 0 24 24"><path d="M4 2l7 16 2.2-6.4L20 9.4z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></symbol>
        <symbol id="i-wall" viewBox="0 0 24 24"><path d="M2 8h20M2 16h20" stroke="currentColor" strokeWidth="1.7"/><path d="M7 8v8M17 8v8" stroke="currentColor" strokeWidth="1.1" opacity=".5"/></symbol>
        <symbol id="i-room" viewBox="0 0 24 24"><path d="M3 4h11l7 7v9H3z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><circle cx="3" cy="4" r="1.7" fill="currentColor"/><circle cx="21" cy="20" r="1.7" fill="currentColor"/></symbol>
        <symbol id="i-door" viewBox="0 0 24 24"><path d="M5 21V3h9v18" stroke="currentColor" strokeWidth="1.7" fill="none"/><path d="M14 21a9 9 0 00-9-9" stroke="currentColor" strokeWidth="1.2" fill="none" strokeDasharray="2.5 2"/></symbol>
        <symbol id="i-win" viewBox="0 0 24 24"><path d="M3 6h18v12H3z" fill="none" stroke="currentColor" strokeWidth="1.7"/><path d="M12 6v12M3 12h18" stroke="currentColor" strokeWidth="1.2"/></symbol>
        <symbol id="i-text" viewBox="0 0 24 24"><path d="M5 5h14M12 5v14M9 19h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></symbol>
        <symbol id="i-meas" viewBox="0 0 24 24"><path d="M2 9h20v6H2z" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M7 9v3M12 9v4M17 9v3" stroke="currentColor" strokeWidth="1.4"/></symbol>
        <symbol id="i-hand" viewBox="0 0 24 24"><path d="M8 12V5.5a1.6 1.6 0 013.2 0V11m0-.5V4.6a1.6 1.6 0 013.2 0V11m0-1v-.9a1.6 1.6 0 013.2 0V15a6 6 0 01-6 6h-1.4a6 6 0 01-5.3-3.2L5 14.4a1.7 1.7 0 013-1.6l1 1.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/></symbol>
        <symbol id="i-tree" viewBox="0 0 24 24"><path d="M12 22v-6" stroke="currentColor" strokeWidth="1.7"/><circle cx="12" cy="10" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M8 8l4 3 4-4" stroke="currentColor" strokeWidth="1.1" fill="none" opacity=".6"/></symbol>
        <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></symbol>
        <symbol id="i-undo" viewBox="0 0 24 24"><path d="M4 10h10a5 5 0 010 10H8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="M8 5l-4.5 5L8 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></symbol>
        <symbol id="i-redo" viewBox="0 0 24 24"><path d="M20 10H10a5 5 0 000 10h6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="M16 5l4.5 5L16 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></symbol>
        <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></symbol>
        <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M12 7v6M12 16.5v.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></symbol>
        <symbol id="i-grid" viewBox="0 0 24 24"><path d="M3 9h18M3 15h18M9 3v18M15 3v18" stroke="currentColor" strokeWidth="1.3"/><rect x="3" y="3" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5"/></symbol>
        <symbol id="i-magnet" viewBox="0 0 24 24"><path d="M6 3v9a6 6 0 0012 0V3h-4v9a2 2 0 01-4 0V3z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M6 7h4M14 7h4" stroke="currentColor" strokeWidth="1.4"/></symbol>
        <symbol id="i-img" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M4 18l5.5-5.5L14 17l3-3 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></symbol>
        <symbol id="i-fit" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="i-zin" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.7"/><path d="M11 8v6M8 11h6M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></symbol>
        <symbol id="i-zout" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.7"/><path d="M8 11h6M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></symbol>
        <symbol id="i-save" viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M8 3v6h8V3M8 21v-6h8v6" fill="none" stroke="currentColor" strokeWidth="1.5"/></symbol>
        <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 6a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></symbol>
        <symbol id="i-dl" viewBox="0 0 24 24"><path d="M12 3v12M7.5 10.5L12 15l4.5-4.5M4 20h16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="i-ul" viewBox="0 0 24 24"><path d="M12 16V4M7.5 8.5L12 4l4.5 4.5M4 20h16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 13a4.5 4.5 0 006.4 0l2.6-2.6a4.5 4.5 0 00-6.4-6.4L11.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="M14 11a4.5 4.5 0 00-6.4 0L5 13.6a4.5 4.5 0 006.4 6.4l1.1-1.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></symbol>
        <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.7"/><path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></symbol>
        <symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M16 5.5A1.5 1.5 0 0014.5 4H5.5A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16" fill="none" stroke="currentColor" strokeWidth="1.5"/></symbol>
        <symbol id="i-rot" viewBox="0 0 24 24"><path d="M20 5v5h-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/><path d="M20 10A8.5 8.5 0 105 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></symbol>
        <symbol id="i-flip" viewBox="0 0 24 24"><path d="M12 3v18" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2.5"/><path d="M9 6L3 12l6 6zM15 6l6 6-6 6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></symbol>
        <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.6"/></symbol>
        <symbol id="i-layer" viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M3 13l9 5 9-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></symbol>
        <symbol id="i-spark" viewBox="0 0 24 24"><path d="M12 2.5l2.1 5.6 5.6 2.1-5.6 2.1L12 17.9l-2.1-5.6L4.3 10.2l5.6-2.1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M18.5 15.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z" fill="currentColor" opacity=".75"/></symbol>
        <symbol id="i-house" viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></symbol>
      </defs>
    </svg>
  );
}

export function Icon({ id, className, style }: { id: string; className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style}>
      <use href={`#${id}`} />
    </svg>
  );
}
