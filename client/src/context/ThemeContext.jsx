import { createContext, useContext, useEffect, useState } from 'react'

const ThemeContext = createContext()

/** Read the persisted theme from localStorage, or null if unset. */
function readStoredTheme() {
    if (typeof localStorage === 'undefined') return null
    const stored = localStorage.getItem('theme')
    return stored === 'light' || stored === 'dark' ? stored : null
}

/** Return the OS-preferred theme, defaulting to light. */
function preferredTheme() {
    if (typeof window === 'undefined' || !window.matchMedia) return 'light'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Holds the active theme, persists it, and exposes a toggle.
 * On mount the value falls back to the OS preference.
 */
export function ThemeProvider({ children }) {
    const [theme, setTheme] = useState(() => readStoredTheme() ?? preferredTheme())

    useEffect(() => {
        document.documentElement.dataset.theme = theme
        localStorage.setItem('theme', theme)
    }, [theme])

    /** Flip the theme between light and dark. */
    function toggle() {
        setTheme(prev => (prev === 'dark' ? 'light' : 'dark'))
    }

    return (
        <ThemeContext.Provider value={{ theme, toggle, setTheme }}>
            {children}
        </ThemeContext.Provider>
    )
}

/** Hook accessor for {@link ThemeProvider}'s value. */
export const useTheme = () => useContext(ThemeContext)
