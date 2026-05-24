import axios from 'axios'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { useApp } from '../../context/AppContext'
import Avatar from '../../components/Avatar'
import Icon from '../../components/Icon'

const PAGE = 50

/**
 * Chat room: paginated history, composer, and per-message actions
 * (edit, rewind, retry, delete, variant switch). Talks to the backend
 * through ``/api/chats/...`` and ``/api/chat/send``.
 */
function Chat() {
    const { id: rawId } = useParams()
    const roomId = Number(rawId)
    const navigate = useNavigate()

    const [chat, setChat] = useState(null)
    const [content, setContent] = useState('')
    const [editingId, setEditingId] = useState(null)
    const [editingText, setEditingText] = useState('')
    const [hiddenMessageId, setHiddenMessageId] = useState(null)
    const bottomRef = useRef(null)
    const topRef = useRef(null)
    const convRef = useRef(null)
    const loadingOlderRef = useRef(false)
    const restoreRef = useRef(null)
    const lastSeenIdRef = useRef(null)

    const { characters, userId, currentUser, fetchChats, styles, personaId, setPersonaId } = useApp()

    const [isWaiting, setIsWaiting] = useState(false)
    const [error, setError] = useState('')
    const [loadError, setLoadError] = useState('')
    const [personas, setPersonas] = useState([])
    const [llms, setLlms] = useState([])
    const composerRef = useRef(null)

    /** Extract a human-readable error from an Axios failure, with a fallback. */
    function errorMessage(err, fallback) {
        return err?.response?.data?.error || err?.message || fallback
    }

    useEffect(() => {
        if (userId === null) return
        lastSeenIdRef.current = null
        setLoadError('')
        axios.get(`/api/chats/${userId}/${roomId}?limit=${PAGE}`)
            .then(response => {
                setChat(response.data)
                fetchChats()
            })
            .catch(err => setLoadError(errorMessage(err, 'Could not load chat.')))
    }, [roomId, userId])

    useEffect(() => {
        if (userId === null) return
        axios.get(`/api/users/${userId}/personas`)
            .then(response => {
                setPersonas(response.data)
                // Keep the active persona if it still exists for this user;
                // otherwise fall back to the first one (or clear if none).
                const stillValid = response.data.some(p => p.id === personaId)
                if (!stillValid) {
                    setPersonaId(response.data.length > 0 ? response.data[0].id : null)
                }
            })
            .catch(() => setPersonas([]))
    }, [userId])

    useEffect(() => {
        if (userId === null) { setLlms([]); return }
        axios.get(`/api/users/${userId}/llms`)
            .then(response => setLlms(response.data))
            .catch(() => setLlms([]))
    }, [userId])

    useEffect(() => {
        if (!chat?.history?.length) return
        const lastId = chat.history.at(-1).id
        const prev = lastSeenIdRef.current
        if (prev === null || lastId > prev) {
            bottomRef.current?.scrollIntoView({ behavior: prev === null ? 'auto' : 'smooth' })
        }
        lastSeenIdRef.current = lastId
    }, [chat?.history])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [isWaiting])

    useLayoutEffect(() => {
        if (restoreRef.current && convRef.current) {
            const conv = convRef.current
            conv.scrollTop = restoreRef.current.prevTop + (conv.scrollHeight - restoreRef.current.prevHeight)
            restoreRef.current = null
            loadingOlderRef.current = false
        }
    }, [chat?.history])

    function loadOlder() {
        if (!chat?.has_more || loadingOlderRef.current || !chat.history.length) return
        loadingOlderRef.current = true
        const conv = convRef.current
        restoreRef.current = { prevHeight: conv.scrollHeight, prevTop: conv.scrollTop }
        const firstId = chat.history[0].id
        axios.get(`/api/chats/${userId}/${roomId}?before=${firstId}&limit=${PAGE}`)
            .then(response => {
                setChat(prev => ({
                    ...prev,
                    history: [...response.data.history, ...prev.history],
                    has_more: response.data.has_more
                }))
            })
            .catch(() => { loadingOlderRef.current = false; restoreRef.current = null })
    }

    useEffect(() => {
        if (!topRef.current || !chat?.has_more) return
        const obs = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) loadOlder()
        }, { root: convRef.current, rootMargin: '100px' })
        obs.observe(topRef.current)
        return () => obs.disconnect()
    }, [chat?.has_more, chat?.history?.[0]?.id])

    function send(e) {
        e.preventDefault()
        if (!canSend) return

        const continue_mode = content.length < 1
        const message = content

        setContent('')
        if (composerRef.current) composerRef.current.style.height = 'auto'
        setIsWaiting(true)
        setError('')

        if (!continue_mode) {
            setChat(prev => {
                const lastId = prev.history.at(-1)?.id ?? -1
                return {
                    ...prev,
                    history: [...prev.history, { id: lastId + 1, role: 'user', content: message }]
                }
            })
        }

        axios.post(`/api/chat/send`, {
            user_id: userId,
            chat_id: roomId,
            character_id: chat.character_id,
            persona_id: personaId,
            style_id: chat.style_id,
            message,
            new_attempt: false,
            continue_mode
        })
        .then(response => {
            setChat(prev => {
                const lastId = prev.history.at(-1)?.id ?? -1
                return {
                    ...prev,
                    history: [...prev.history, {
                        id: lastId + 1,
                        role: 'assistant',
                        content: [response.data.reply],
                        selected_index: 0
                    }]
                }
            })
            setIsWaiting(false)
        })
        .catch(err => {
            // Roll back the optimistic user bubble and restore the composer
            // so the user can retry or amend (missing model, OOM, etc.).
            if (!continue_mode) {
                setChat(prev => prev && ({ ...prev, history: prev.history.slice(0, -1) }))
                setContent(message)
            }
            setIsWaiting(false)
            setError(errorMessage(err, 'Could not send message.'))
        })
    }

    function retry() {
        if (!canSend) return
        const replacedId = chat.history.at(-1).id
        setHiddenMessageId(replacedId)
        setIsWaiting(true)
        setError('')
        axios.post(`/api/chat/send`, {
            user_id: userId,
            chat_id: roomId,
            character_id: chat.character_id,
            persona_id: personaId,
            style_id: chat.style_id,
            new_attempt: true,
            continue_mode: false
        })
        .then(response => {
            setChat(prev => {
                const last = prev.history.at(-1)
                const newIndex = last.content.length
                const updated = {
                    ...last,
                    content: [...last.content, response.data.reply],
                    selected_index: newIndex
                }
                axios.put(`/api/chats/${userId}/${roomId}/messages/${last.id}`, {
                    selected_index: newIndex
                }).catch(() => {})
                return { ...prev, history: [...prev.history.slice(0, -1), updated] }
            })
            setHiddenMessageId(null)
            setIsWaiting(false)
        })
        .catch(err => {
            setHiddenMessageId(null)
            setIsWaiting(false)
            setError(errorMessage(err, 'Retry failed.'))
        })
    }

    function selectVariant(messageId, direction) {
        const index = chat.history.findIndex(m => m.id === messageId)
        const message = chat.history[index]
        const count = message.content.length
        const newIndex = (message.selected_index + direction + count) % count

        const newHistory = [...chat.history]
        newHistory[index] = { ...message, selected_index: newIndex }
        setChat({ ...chat, history: newHistory })

        axios.put(`/api/chats/${userId}/${roomId}/messages/${messageId}`, { selected_index: newIndex })
            .catch(err => setError(errorMessage(err, 'Could not save variant selection.')))
    }

    function rewind(messageId) {
        axios.post(`/api/chats/${userId}/${roomId}/rewind/${messageId}?limit=${PAGE}`)
            .then(response => {
                lastSeenIdRef.current = null
                setChat(prev => ({
                    ...prev,
                    history: response.data.history,
                    has_more: response.data.has_more
                }))
            })
            .catch(err => setError(errorMessage(err, 'Could not rewind.')))
    }

    function startEdit(message) {
        const current = Array.isArray(message.content)
            ? message.content[message.selected_index]
            : message.content
        setEditingId(message.id)
        setEditingText(current)
    }

    function cancelEdit() {
        setEditingId(null)
        setEditingText('')
    }

    function saveEdit(message) {
        const newContent = Array.isArray(message.content)
            ? message.content.map((c, i) => i === message.selected_index ? editingText : c)
            : editingText

        const newHistory = chat.history.map(m =>
            m.id === message.id ? { ...m, content: newContent } : m
        )
        setChat({ ...chat, history: newHistory })

        axios.put(`/api/chats/${userId}/${roomId}/messages/${message.id}`, { content: newContent })
            .catch(err => setError(errorMessage(err, 'Could not save edit.')))

        setEditingId(null)
        setEditingText('')
    }

    function deleteChat() {
        if (!confirm('Delete this chat entirely? This cannot be undone.')) return
        axios.delete(`/api/chats/${userId}/${roomId}`)
            .then(() => fetchChats())
            .then(() => navigate('/'))
            .catch(err => setError(errorMessage(err, 'Could not delete chat.')))
    }

    function setChatStyle(styleId) {
        const id = styleId === '' ? null : Number(styleId)
        setChat(prev => ({ ...prev, style_id: id }))
        axios.put(`/api/chats/${userId}/${roomId}/style`, { style_id: id })
            .catch(err => setError(errorMessage(err, 'Could not change chat style.')))
    }

    function setChatLlm(llmId) {
        const id = llmId === '' ? null : Number(llmId)
        setChat(prev => ({ ...prev, llm_id: id }))
        axios.put(`/api/chats/${userId}/${roomId}/llm`, { llm_id: id })
            .catch(err => setError(errorMessage(err, 'Could not change LLM.')))
    }

    function deleteMessage(messageId) {
        const newHistory = chat.history.filter(m => m.id !== messageId)
        setChat({ ...chat, history: newHistory })
        axios.delete(`/api/chats/${userId}/${roomId}/messages/${messageId}`)
            .catch(err => setError(errorMessage(err, 'Could not delete message.')))
    }

    const character = chat ? characters.find(c => c.id === chat.character_id) : null

    const lastUserId = chat ? [...chat.history].reverse().find(m => m.role.toLowerCase() === 'user')?.id : null
    const lastAssistantId = chat ? [...chat.history].reverse().find(m => m.role.toLowerCase() === 'assistant')?.id : null

    const needsStyle = chat && chat.style_id == null
    const needsLlm = chat && (chat.llm_id == null)
    const noPersonas = personas.length === 0
    const selectedLlm = chat && chat.llm_id != null ? llms.find(l => l.id === chat.llm_id) : null
    const llmMissing = chat && chat.llm_id != null && llms.length > 0 && !selectedLlm
    const canSend = !needsStyle && !needsLlm && !noPersonas && !llmMissing

    if (loadError) {
        return (
            <div className='chat'>
                <div className='modal__error' style={{ margin: 24 }}>{loadError}</div>
            </div>
        )
    }

    return (
        <div className='chat'>
            <div className='chat__header'>
                {character ? (
                    <Link to={`/character/${character.id}`} className='chat__title'>
                        <Avatar
                            src={`/api/characters/${character.id}/picture`}
                            version={character.last_update}
                            name={character.name}
                            size='md'
                        />
                        <span className='chat__title-name'>{character.name}</span>
                    </Link>
                ) : <span className='chat__title'>Chat</span>}

                {chat && (
                    <div className='chat__header-actions'>
                        {personas.length > 1 && (
                            <select
                                className='select'
                                value={personaId ?? ''}
                                onChange={(e) => setPersonaId(Number(e.target.value))}
                            >
                                {personas.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                        )}
                        <select
                            className='select'
                            value={chat.style_id ?? ''}
                            onChange={(e) => setChatStyle(e.target.value)}
                        >
                            <option value='' disabled>Pick a chat style…</option>
                            {styles.map(s => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                        <select
                            className='select'
                            value={chat.llm_id ?? ''}
                            onChange={(e) => setChatLlm(e.target.value)}
                        >
                            <option value='' disabled>Pick an LLM…</option>
                            {llms.map(l => (
                                <option key={l.id} value={l.id}>{l.name}</option>
                            ))}
                        </select>
                        <button
                            className='btn btn--icon btn--danger'
                            onClick={deleteChat}
                            aria-label='Delete chat'
                            title='Delete chat'
                        >
                            <Icon name='trash' />
                        </button>
                    </div>
                )}
            </div>

            {error && (
                <div className='modal__error' style={{ margin: '8px 16px' }} onClick={() => setError('')}>
                    {error}
                </div>
            )}

            <div className='chat__conversation' ref={convRef}>
                <div className='chat__inner'>
                    {chat?.has_more && <div ref={topRef} className='chat__load-sentinel'>Loading older messages…</div>}

                    {character && chat && chat.history.map((message) => {
                        const isAssistant = message.role.toLowerCase() === 'assistant'
                        const text = Array.isArray(message.content)
                            ? message.content[message.selected_index]
                            : message.content
                        const isLast = message.id === chat.history.at(-1).id
                        const isLastOfRole = message.id === (isAssistant ? lastAssistantId : lastUserId)
                        const hasVariants = isAssistant && isLast && Array.isArray(message.content) && message.content.length > 1
                        const isEditing = editingId === message.id
                        const isHidden = message.id === hiddenMessageId

                        const author = isAssistant ? character.name : (currentUser?.name ?? 'You')

                        return (
                            <div
                                key={message.id}
                                className={`message${isEditing ? ' is-editing' : ''}${isHidden ? ' is-hidden' : ''}`}
                            >
                                <span className='message__author'>{author}</span>

                                {isEditing ? (
                                    <textarea
                                        className='message__edit'
                                        value={editingText}
                                        ref={(el) => {
                                            if (!el) return
                                            el.style.height = 'auto'
                                            el.style.height = el.scrollHeight + 'px'
                                        }}
                                        onChange={(e) => {
                                            setEditingText(e.target.value)
                                            e.target.style.height = 'auto'
                                            e.target.style.height = e.target.scrollHeight + 'px'
                                        }}
                                    />
                                ) : (
                                    <div className='message__body markdown'>
                                        <ReactMarkdown components={{ em: ({ children }) => <em className='subtle'>{children}</em> }}>
                                            {text}
                                        </ReactMarkdown>
                                    </div>
                                )}

                                <div className='message__actions'>
                                    {hasVariants && (
                                        <span className='message__variants'>
                                            <button className='btn btn--sm btn--icon' onClick={() => selectVariant(message.id, -1)} aria-label='Previous variant'>
                                                <Icon name='chevronLeft' />
                                            </button>
                                            <span>{message.selected_index + 1}/{message.content.length}</span>
                                            <button className='btn btn--sm btn--icon' onClick={() => selectVariant(message.id, 1)} aria-label='Next variant'>
                                                <Icon name='chevronRight' />
                                            </button>
                                        </span>
                                    )}
                                    {isLast && isAssistant && !isEditing && (
                                        <button className='btn btn--sm' onClick={retry}>
                                            <Icon name='retry' /> Retry
                                        </button>
                                    )}
                                    {isLastOfRole && !isEditing && (
                                        <button className='btn btn--sm' onClick={() => startEdit(message)}>
                                            <Icon name='edit' /> Edit
                                        </button>
                                    )}
                                    {isEditing && (
                                        <>
                                            <button className='btn btn--sm btn--primary' onClick={() => saveEdit(message)}>Save</button>
                                            <button className='btn btn--sm' onClick={cancelEdit}>Cancel</button>
                                        </>
                                    )}
                                    {!isEditing && (
                                        <>
                                            <button className='btn btn--sm' onClick={() => rewind(message.id)}>
                                                <Icon name='rewind' /> Rewind
                                            </button>
                                            <button className='btn btn--sm btn--danger' onClick={() => deleteMessage(message.id)} aria-label='Delete message'>
                                                <Icon name='trash' />
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        )
                    })}

                    {!needsStyle && isWaiting && (
                        <div className='chat__status'>
                            <span className='chat__typing-dot' />
                            <span className='chat__typing-dot' />
                            <span className='chat__typing-dot' />
                            <span>Replying</span>
                        </div>
                    )}

                    {needsStyle && (
                        <div className='chat__empty'>Pick a chat style above to start chatting.</div>
                    )}
                    {!needsStyle && needsLlm && (
                        <div className='chat__empty'>Pick an LLM above to start chatting.</div>
                    )}
                    {!needsStyle && !needsLlm && noPersonas && (
                        <div className='chat__empty'>You have no personas. Create one in your session settings to chat.</div>
                    )}
                    {!needsStyle && !needsLlm && !noPersonas && llmMissing && (
                        <div className='chat__empty'>This chat's LLM is no longer registered. Pick another above.</div>
                    )}

                    <div ref={bottomRef} />
                </div>
            </div>

            <form onSubmit={send} className='chat__composer'>
                <div className='chat__composer-inner'>
                    <textarea
                        ref={composerRef}
                        value={content}
                        placeholder='Type a message.'
                        onChange={(e) => {
                            setContent(e.target.value)
                            e.target.style.height = 'auto'
                            e.target.style.height = e.target.scrollHeight + 'px'
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                send(e)
                            }
                        }}
                    />
                    <button
                        type='submit'
                        className='btn btn--primary btn--icon'
                        disabled={!canSend || isWaiting}
                        aria-label='Send message'
                        title='Send'
                    >
                        <Icon name='send' />
                    </button>
                </div>
            </form>
        </div>
    )
}

export default Chat
