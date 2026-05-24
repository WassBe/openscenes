/** Inline SVG icon set (Lucide-style, 24×24 viewBox, currentColor strokes). */

const PATHS = {
    home:    <><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5Z" /></>,
    search:  <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
    manage:  <><path d="M4 6h16M4 12h16M4 18h10" /></>,
    user:    <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-7 8-7s8 3 8 7" /></>,
    plus:    <><path d="M12 5v14M5 12h14" /></>,
    close:   <><path d="M6 6l12 12M18 6 6 18" /></>,
    sun:     <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>,
    moon:    <><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></>,
    send:    <><path d="M5 12 21 4l-8 16-2-7-6-1Z" /></>,
    trash:   <><path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M10 11v6M14 11v6" /></>,
    edit:    <><path d="M4 20h4l10-10-4-4L4 16v4Z" /><path d="m13 6 4 4" /></>,
    rewind:  <><path d="M11 19 3 12l8-7M21 19l-8-7 8-7" /></>,
    retry:   <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>,
    chevronLeft:  <><path d="m15 18-6-6 6-6" /></>,
    chevronRight: <><path d="m9 18 6-6-6-6" /></>,
    chevronDown:  <><path d="m6 9 6 6 6-6" /></>,
    save:    <><path d="M5 4h11l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /><path d="M7 4v6h9V4M8 14h8v7H8z" /></>,
    upload:  <><path d="M12 3v12" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" /></>,
    spark:   <><path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4" /></>,
    arrowRight: <><path d="M5 12h14M13 5l7 7-7 7" /></>,
    back:    <><path d="M19 12H5M12 5l-7 7 7 7" /></>,
    chat:    <><path d="M21 12a8 8 0 0 1-12 7l-5 1 1-5a8 8 0 1 1 16-3Z" /></>,
    menu:    <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    copy:    <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>,
}

/**
 * Render an icon from the {@link PATHS} set. ``title`` makes the icon
 * announced to assistive tech; otherwise it stays decorative.
 */
function Icon({ name, className = 'icon', strokeWidth = 2, title, ...rest }) {
    const content = PATHS[name]
    if (!content) return null
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden={title ? undefined : 'true'}
            role={title ? 'img' : undefined}
            {...rest}
        >
            {title && <title>{title}</title>}
            {content}
        </svg>
    )
}

export default Icon
