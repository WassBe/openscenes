import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import axios from 'axios'

const AppContext = createContext()

/** Read the persisted active user id from localStorage, or null if unset. */
function readStoredUserId() {
    const raw = localStorage.getItem('userId')
    if (raw === null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
}

/** Read the persisted active persona id from localStorage, or null if unset. */
function readStoredPersonaId() {
    const raw = localStorage.getItem('personaId')
    if (raw === null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
}

/**
 * Provides the shared application state: users, characters, chat styles,
 * chats, the active user id, and helpers to refetch each collection. List
 * fetches fall back to an empty array on failure so the UI keeps rendering.
 */
export function AppProvider({ children }) {
    // Drop legacy global selections (the chat-style choice is now per-chat).
    if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('activeModelId')
        localStorage.removeItem('activeStyleId')
    }

    const [userId, setUserId] = useState(readStoredUserId)
    const [personaId, setPersonaIdState] = useState(readStoredPersonaId)
    const [users, setUsers] = useState([])
    const [characters, setCharacters] = useState([])
    const [styles, setStyles] = useState([])
    const [chats, setChats] = useState([])
    const [latests, setLatests] = useState([])

    /** Persist the active persona id (null clears it). */
    const setPersonaId = useCallback((id) => {
        if (id === null || id === undefined) {
            localStorage.removeItem('personaId')
            setPersonaIdState(null)
        } else {
            localStorage.setItem('personaId', String(id))
            setPersonaIdState(id)
        }
    }, [])

    const fetchUsers = useCallback(() => {
        return axios.get('/api/users')
            .then(response => { setUsers(response.data); return response.data })
            .catch(() => { setUsers([]); return [] })
    }, [])

    const fetchCharacters = useCallback(() => {
        return axios.get('/api/characters')
            .then(response => { setCharacters(response.data); return response.data })
            .catch(() => { setCharacters([]); return [] })
    }, [])

    const fetchStyles = useCallback(() => {
        return axios.get('/api/styles')
            .then(response => { setStyles(response.data); return response.data })
            .catch(() => { setStyles([]); return [] })
    }, [])

    const fetchChats = useCallback(() => {
        if (userId === null) { setChats([]); return Promise.resolve([]) }
        return axios.get(`/api/chats/${userId}`).then(response => {
            setChats(response.data)
            return response.data
        }).catch(() => { setChats([]); return [] })
    }, [userId])

    useEffect(() => {
        fetchUsers()
        fetchCharacters()
        fetchStyles()
    }, [fetchUsers, fetchCharacters, fetchStyles])

    useEffect(() => {
        fetchChats()
    }, [fetchChats])

    // Derive a "recent chats" view by joining chats with their characters.
    useEffect(() => {
        setLatests(
            chats
                .map(chat => {
                    const character = characters.find(character => character.id === chat.character_id)
                    if (!character) return null
                    return { ...character, chat_id: chat.id, last_update: chat.last_update }
                })
                .filter(Boolean)
        )
    }, [characters, chats])

    /** Persist the active user id and remember it for next launches. */
    function signIn(id) {
        localStorage.setItem('userId', String(id))
        setUserId(id)
        // Personas are per-user, so the previous selection no longer applies.
        setPersonaId(null)
    }

    /** Clear the active user id. */
    function signOut() {
        localStorage.removeItem('userId')
        setUserId(null)
        setPersonaId(null)
    }

    const currentUser = users.find(u => u.id === userId) || null

    return (
        <AppContext.Provider value={{
            userId, currentUser,
            personaId, setPersonaId,
            users, fetchUsers,
            characters, fetchCharacters,
            styles, fetchStyles,
            chats, fetchChats, latests,
            signIn, signOut
        }}>
            {children}
        </AppContext.Provider>
    )
}

/** Hook accessor for {@link AppProvider}'s value. */
export const useApp = () => useContext(AppContext)
