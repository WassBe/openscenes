import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { useApp } from '../context/AppContext'
import Avatar from './Avatar'
import Icon from './Icon'

const blankPersona = { id: null, name: '', description: '', content: '' }

/**
 * Modal for switching the active user and managing their personas.
 * Has three sub-modes: ``list`` (select), ``create`` (new user),
 * ``edit`` (rename, picture, personas CRUD).
 */
function SessionModal({ onClose }) {
    const { users, userId, fetchUsers, signIn, signOut } = useApp()

    const [mode, setMode] = useState('list') // 'list' | 'create' | 'edit'
    const [error, setError] = useState('')

    const [draftName, setDraftName] = useState('')
    const [editTarget, setEditTarget] = useState(null)

    const [personas, setPersonas] = useState([])
    const [personaDraft, setPersonaDraft] = useState(null)
    const [picVersion, setPicVersion] = useState(0)

    function backToList() {
        setMode('list')
        setDraftName('')
        setEditTarget(null)
        setPersonas([])
        setPersonaDraft(null)
        setError('')
    }

    function loadPersonas(uid) {
        return axios.get(`/api/users/${uid}/personas`)
            .then(response => setPersonas(response.data))
            .catch(() => setPersonas([]))
    }

    function uploadUserPicture(e) {
        const file = e.target.files[0]
        e.target.value = ''
        if (!file || !editTarget) return
        const fd = new FormData()
        fd.append('file', file)
        axios.put(`/api/users/${editTarget.id}/picture`, fd)
            .then(() => { setPicVersion(v => v + 1); fetchUsers() })
            .catch(err => setError(err.response?.data?.error || 'Could not upload picture.'))
    }

    function removeUserPicture() {
        if (!editTarget) return
        if (!confirm('Remove this user\'s picture?')) return
        axios.delete(`/api/users/${editTarget.id}/picture`)
            .then(() => { setPicVersion(v => v + 1); fetchUsers() })
            .catch(err => setError(err.response?.data?.error || 'Could not remove picture.'))
    }

    function enterEdit(user) {
        setEditTarget(user)
        setDraftName(user.name)
        setError('')
        setPersonaDraft(null)
        setMode('edit')
        loadPersonas(user.id)
    }

    function handleSelect(user) {
        signIn(user.id)
        onClose()
    }

    function handleCreate(e) {
        e.preventDefault()
        const name = draftName.trim()
        if (!name) { setError('Username required.'); return }
        axios.post(`/api/users`, { username: name })
            .then(response => fetchUsers().then(() => enterEdit(response.data)))
            .catch(err => setError(err.response?.data?.error || 'Could not create user.'))
    }

    function handleSaveUsername() {
        const name = draftName.trim()
        if (!name || !editTarget || name === editTarget.name) return
        axios.put(`/api/users/${editTarget.id}`, { username: name })
            .then(() => fetchUsers().then(() => setError('')))
            .catch(err => setError(err.response?.data?.error || 'Could not update username.'))
    }

    function handleDeleteUser(user) {
        if (!confirm(`Delete user "${user.name}"? This wipes their chats and personas.`)) return
        axios.delete(`/api/users/${user.id}`)
            .then(() => {
                if (user.id === userId) signOut()
                fetchUsers()
            })
            .catch(err => setError(err.response?.data?.error || 'Could not delete user.'))
    }

    function startNewPersona() {
        setPersonaDraft({ ...blankPersona })
        setError('')
    }

    function startEditPersona(persona) {
        axios.get(`/api/users/${editTarget.id}/personas/${persona.id}`)
            .then(response => setPersonaDraft({
                id: response.data.id,
                name: response.data.name,
                description: response.data.description || '',
                content: response.data.content || ''
            }))
            .catch(err => setError(err.response?.data?.error || 'Could not load persona.'))
    }

    function handleSavePersona(e) {
        e.preventDefault()
        const draft = personaDraft
        if (!draft.name.trim()) { setError('Persona name required.'); return }

        const payload = {
            name: draft.name.trim(),
            description: draft.description,
            content: draft.content
        }
        const url = `/api/users/${editTarget.id}/personas`

        const req = draft.id == null
            ? axios.post(url, payload)
            : axios.put(`${url}/${draft.id}`, payload)

        req
            .then(() => loadPersonas(editTarget.id))
            .then(() => { setPersonaDraft(null); setError('') })
            .catch(err => setError(err.response?.data?.error || 'Could not save persona.'))
    }

    function handleDeletePersona(persona) {
        if (!confirm(`Delete persona "${persona.name}"?`)) return
        axios.delete(`/api/users/${editTarget.id}/personas/${persona.id}`)
            .then(() => loadPersonas(editTarget.id))
            .catch(err => setError(err.response?.data?.error || 'Could not delete persona.'))
    }

    function handlePersonaUpload(e) {
        const file = e.target.files[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = (ev) => setPersonaDraft(d => ({ ...d, content: ev.target.result }))
        reader.readAsText(file)
        e.target.value = ''
    }

    // Dismiss on Escape, same as clicking the backdrop.
    useEffect(() => {
        const handler = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [onClose])

    const startedOnBackdrop = useRef(false)

    return (
        <div
            className='modal-backdrop'
            onMouseDown={(e) => { startedOnBackdrop.current = e.target === e.currentTarget }}
            onMouseUp={(e) => { if (startedOnBackdrop.current && e.target === e.currentTarget) onClose() }}
        >
            <div className='modal'>
                <div className='modal__header'>
                    {mode !== 'list' && (
                        <button className='modal__close' onClick={backToList} aria-label='Back'>
                            <Icon name='back' />
                        </button>
                    )}
                    <h2 className='modal__title'>
                        {mode === 'list' && 'Sessions'}
                        {mode === 'create' && 'New user'}
                        {mode === 'edit' && (editTarget?.name ?? 'User')}
                    </h2>
                    {mode === 'list' && (
                        <button
                            className='btn btn--sm'
                            onClick={() => { setMode('create'); setDraftName(''); setError('') }}
                        >
                            <Icon name='plus' /> New
                        </button>
                    )}
                    <button className='modal__close' onClick={onClose} aria-label='Close'>
                        <Icon name='close' />
                    </button>
                </div>

                {error && <div className='modal__error'>{error}</div>}

                <div className='modal__body'>
                    {mode === 'list' && (
                        <ul className='list'>
                            {users.length === 0 && <li className='list-empty'>No users yet — create one to start.</li>}
                            {users.map(user => (
                                <li key={user.id} className={`list-item${user.id === userId ? ' is-active' : ''}`}>
                                    <Avatar
                                        src={`/api/users/${user.id}/picture`}
                                        version={user.reg_date}
                                        name={user.name}
                                        size='sm'
                                    />
                                    <div className='list-item__body'>
                                        <span className='list-item__name'>
                                            {user.name}{user.id === userId && ' · current'}
                                        </span>
                                    </div>
                                    <div className='list-item__actions'>
                                        <button className='btn btn--sm btn--primary' onClick={() => handleSelect(user)}>Select</button>
                                        <button className='btn btn--sm btn--icon' aria-label='Edit' onClick={() => enterEdit(user)}><Icon name='edit' /></button>
                                        <button className='btn btn--sm btn--icon btn--danger' aria-label='Delete' onClick={() => handleDeleteUser(user)}><Icon name='trash' /></button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}

                    {mode === 'create' && (
                        <form onSubmit={handleCreate} className='field'>
                            <label className='field__label'>Username</label>
                            <input
                                className='input'
                                autoFocus
                                value={draftName}
                                onChange={(e) => setDraftName(e.target.value)}
                                placeholder='username'
                            />
                            <div className='row row--end'>
                                <button type='submit' className='btn btn--primary'>Create</button>
                            </div>
                        </form>
                    )}

                    {mode === 'edit' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                            <div className='picture-edit'>
                                <Avatar
                                    src={`/api/users/${editTarget.id}/picture`}
                                    version={picVersion}
                                    name={editTarget?.name}
                                    size='lg'
                                    round
                                />
                                <div className='picture-edit__controls'>
                                    <label className='upload'>
                                        <Icon name='upload' /> Upload picture
                                        <input type='file' accept='image/*' onChange={uploadUserPicture} hidden />
                                    </label>
                                    <button type='button' className='btn btn--sm btn--ghost' onClick={removeUserPicture}>Remove</button>
                                    <span className='field__hint'>PNG / JPG / GIF / WEBP — optional.</span>
                                </div>
                            </div>

                            <div className='field'>
                                <label className='field__label'>Username</label>
                                <div className='row'>
                                    <input
                                        className='input'
                                        value={draftName}
                                        onChange={(e) => setDraftName(e.target.value)}
                                    />
                                    <button className='btn btn--primary' onClick={handleSaveUsername}>Save</button>
                                </div>
                            </div>

                            <div>
                                <div className='row' style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                                    <span className='section__title' style={{ marginBottom: 0 }}>Personas</span>
                                    {!personaDraft && (
                                        <button className='btn btn--sm' onClick={startNewPersona}>
                                            <Icon name='plus' /> Add
                                        </button>
                                    )}
                                </div>

                                {!personaDraft && (
                                    <ul className='list'>
                                        {personas.length === 0 && <li className='list-empty'>No personas yet.</li>}
                                        {personas.map(p => (
                                            <li key={p.id} className='list-item'>
                                                <div className='list-item__body'>
                                                    <span className='list-item__name'>{p.name}</span>
                                                    {p.description && <span className='list-item__meta'>{p.description}</span>}
                                                </div>
                                                <div className='list-item__actions'>
                                                    <button className='btn btn--sm btn--icon' onClick={() => startEditPersona(p)} aria-label='Edit'><Icon name='edit' /></button>
                                                    <button className='btn btn--sm btn--icon btn--danger' onClick={() => handleDeletePersona(p)} aria-label='Delete'><Icon name='trash' /></button>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                {personaDraft && (
                                    <form onSubmit={handleSavePersona} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                        <div className='field'>
                                            <label className='field__label'>Name</label>
                                            <input
                                                className='input'
                                                autoFocus
                                                value={personaDraft.name}
                                                onChange={(e) => setPersonaDraft(d => ({ ...d, name: e.target.value }))}
                                                placeholder='e.g. Adventurer'
                                            />
                                        </div>

                                        <div className='field'>
                                            <label className='field__label'>Description</label>
                                            <input
                                                className='input'
                                                value={personaDraft.description}
                                                onChange={(e) => setPersonaDraft(d => ({ ...d, description: e.target.value }))}
                                                placeholder='short summary (optional)'
                                            />
                                        </div>

                                        <div className='field'>
                                            <label className='field__label'>Content (markdown)</label>
                                            <div className='upload-row'>
                                                <label className='upload'>
                                                    <Icon name='upload' /> Upload .md
                                                    <input type='file' accept='.md,.txt,text/markdown,text/plain' onChange={handlePersonaUpload} hidden />
                                                </label>
                                                <span className='field__hint'>…or write below.</span>
                                            </div>
                                            <textarea
                                                className='textarea'
                                                rows={8}
                                                value={personaDraft.content}
                                                onChange={(e) => setPersonaDraft(d => ({ ...d, content: e.target.value }))}
                                                placeholder="Write the persona's description, traits, voice, backstory…"
                                            />
                                        </div>

                                        <div className='row row--end'>
                                            <button type='button' className='btn' onClick={() => { setPersonaDraft(null); setError('') }}>Cancel</button>
                                            <button type='submit' className='btn btn--primary'>Save persona</button>
                                        </div>
                                    </form>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {mode === 'edit' && (
                    <div className='modal__footer'>
                        <button className='btn btn--primary' onClick={() => { signIn(editTarget.id); onClose() }}>Done</button>
                    </div>
                )}

                {userId !== null && mode === 'list' && (
                    <div className='modal__footer'>
                        <button className='btn btn--danger' onClick={() => { signOut(); onClose() }}>Disconnect</button>
                    </div>
                )}
            </div>
        </div>
    )
}

export default SessionModal
