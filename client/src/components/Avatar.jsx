import { useEffect, useState } from 'react'

/** Two-letter initials from a name (e.g. "Jane Doe" → "JD"). */
function initialsOf(name) {
    if (!name) return ''
    const parts = name.trim().split(/\s+/)
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * Round avatar that shows an image with an initials fallback.
 * ``version`` is appended as a cache-buster after re-uploads;
 * ``size`` accepts the standard sm/md/lg/xl tokens.
 */
function Avatar({ src, version, name, size = 'md', className = '' }) {
    const [failed, setFailed] = useState(false)

    useEffect(() => { setFailed(false) }, [src, version])

    const url = src ? `${src}${src.includes('?') ? '&' : '?'}v=${version ?? ''}` : null
    const sizeClass = size === 'md' ? '' : `avatar--${size}`
    const classes = ['avatar', sizeClass, className]
        .filter(Boolean).join(' ')

    return (
        <div className={classes}>
            {url && !failed
                ? <img src={url} alt="" onError={() => setFailed(true)} />
                : <span>{initialsOf(name)}</span>}
        </div>
    )
}

export default Avatar
