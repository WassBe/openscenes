import { useState } from 'react'
import axios from 'axios'
import { useApp } from '../../context/AppContext'
import Avatar from '../../components/Avatar'
import Icon from '../../components/Icon'

const blank = { id: null, name: '', description: '', persona: '', context: '', opening: '', pendingPicture: null }

/** Labelled textarea paired with an upload button that fills it from a file. */
function FieldWithUpload({ label, accept, value, onChange, onUpload, placeholder, rows }) {
    return (
        <div className='field'>
            <label className='field__label'>{label}</label>
            <div className='upload-row'>
                <label className='upload'>
                    <Icon name='upload' /> Upload
                    <input type='file' accept={accept} onChange={onUpload} hidden />
                </label>
                <span className='field__hint'>…or write below.</span>
            </div>
            <textarea
                className='textarea'
                rows={rows}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
            />
        </div>
    )
}

/** Manage tab: list, create, edit, and delete characters and their files. */
function CharactersTab() {
    const { characters, fetchCharacters, fetchChats } = useApp()
    const [draft, setDraft] = useState(null)
    const [error, setError] = useState('')

    function startNew() { setDraft({ ...blank }); setError('') }

    function startEdit(character) {
        axios.get(`/api/characters/${character.id}`)
            .then(response => setDraft({
                id: response.data.id,
                name: response.data.name || '',
                description: response.data.description || '',
                persona: response.data.persona || '',
                context: response.data.context || '',
                opening: response.data.opening || '',
                last_update: response.data.last_update
            }))
            .catch(err => setError(err.response?.data?.error || 'Could not load character.'))
    }

    function uploadPicture(e) {
        const file = e.target.files[0]
        e.target.value = ''
        if (!file || draft.id == null) return
        const fd = new FormData()
        fd.append('file', file)
        axios.put(`/api/characters/${draft.id}/picture`, fd)
            .then(response => { setDraft(d => ({ ...d, last_update: response.data.last_update })); fetchCharacters() })
            .catch(err => setError(err.response?.data?.error || 'Could not upload picture.'))
    }

    function removePicture() {
        if (draft.id == null) return
        if (!confirm('Remove this character\'s picture?')) return
        axios.delete(`/api/characters/${draft.id}/picture`)
            .then(response => { setDraft(d => ({ ...d, last_update: response.data.last_update })); fetchCharacters() })
            .catch(err => setError(err.response?.data?.error || 'Could not remove picture.'))
    }

    function cancel() { setDraft(null); setError('') }

    function save(e) {
        e.preventDefault()
        if (!draft.name.trim()) { setError('Name required.'); return }

        const payload = {
            name: draft.name.trim(),
            description: draft.description,
            persona: draft.persona,
            context: draft.context,
            opening: draft.opening
        }

        const isNew = draft.id == null
        const req = isNew
            ? axios.post('/api/characters', payload)
            : axios.put(`/api/characters/${draft.id}`, payload)

        req
            .then(response => {
                if (isNew && draft.pendingPicture) {
                    const fd = new FormData()
                    fd.append('file', draft.pendingPicture)
                    return axios.put(`/api/characters/${response.data.id}/picture`, fd).catch(() => {})
                }
            })
            .then(() => fetchCharacters())
            .then(() => { setDraft(null); setError('') })
            .catch(err => setError(err.response?.data?.error || 'Could not save character.'))
    }

    function remove(character) {
        if (!confirm(`Delete character "${character.name}"? This wipes its files.`)) return
        axios.delete(`/api/characters/${character.id}`)
            .then(() => Promise.all([fetchCharacters(), fetchChats()]))
            .catch(err => setError(err.response?.data?.error || 'Could not delete character.'))
    }

    function uploadInto(field) {
        return (e) => {
            const file = e.target.files[0]
            if (!file) return
            const reader = new FileReader()
            reader.onload = (ev) => setDraft(d => ({ ...d, [field]: ev.target.result }))
            reader.readAsText(file)
            e.target.value = ''
        }
    }

    if (draft) {
        return (
            <form onSubmit={save} className='manage-form'>
                <div className='manage-form__header'>
                    <h2 className='manage-form__title'>
                        {draft.id == null ? 'New character' : (draft.name || '(unnamed)')}
                    </h2>
                    <button type='button' className='btn' onClick={cancel}>Cancel</button>
                </div>
                {error && <div className='modal__error'>{error}</div>}

                {draft.id != null ? (
                    <div className='picture-edit'>
                        <Avatar
                            src={`/api/characters/${draft.id}/picture`}
                            version={draft.last_update}
                            name={draft.name}
                            size='lg'
                        />
                        <div className='picture-edit__controls'>
                            <label className='upload'>
                                <Icon name='upload' /> Upload picture
                                <input type='file' accept='image/*' onChange={uploadPicture} hidden />
                            </label>
                            <button type='button' className='btn btn--sm btn--ghost' onClick={removePicture}>Remove</button>
                            <span className='field__hint'>PNG / JPG / GIF / WEBP — optional.</span>
                        </div>
                    </div>
                ) : (
                    <div className='picture-edit'>
                        <Avatar name={draft.name || '?'} size='lg' />
                        <div className='picture-edit__controls'>
                            <label className='upload'>
                                <Icon name='upload' /> {draft.pendingPicture ? draft.pendingPicture.name : 'Upload picture'}
                                <input
                                    type='file'
                                    accept='image/*'
                                    onChange={(e) => setDraft(d => ({ ...d, pendingPicture: e.target.files[0] || null }))}
                                    hidden
                                />
                            </label>
                            <span className='field__hint'>PNG / JPG / GIF / WEBP — optional.</span>
                        </div>
                    </div>
                )}

                <div className='field'>
                    <label className='field__label'>Name</label>
                    <input
                        className='input'
                        autoFocus
                        value={draft.name}
                        onChange={(e) => setDraft(d => ({ ...d, name: e.target.value }))}
                        placeholder='e.g. Leon'
                    />
                </div>

                <div className='field'>
                    <label className='field__label'>Description</label>
                    <input
                        className='input'
                        value={draft.description}
                        onChange={(e) => setDraft(d => ({ ...d, description: e.target.value }))}
                        placeholder='short blurb shown in lists'
                    />
                </div>

                <FieldWithUpload
                    label='Persona (markdown)'
                    accept='.md,.txt,text/markdown,text/plain'
                    value={draft.persona}
                    onChange={(v) => setDraft(d => ({ ...d, persona: v }))}
                    onUpload={uploadInto('persona')}
                    placeholder='Who this character is — traits, voice, backstory…'
                    rows={10}
                />

                <FieldWithUpload
                    label='Context (markdown)'
                    accept='.md,.txt,text/markdown,text/plain'
                    value={draft.context}
                    onChange={(v) => setDraft(d => ({ ...d, context: v }))}
                    onUpload={uploadInto('context')}
                    placeholder='Where the scene takes place, the situation…'
                    rows={8}
                />

                <FieldWithUpload
                    label='Opening message (text)'
                    accept='.txt,.md,text/plain,text/markdown'
                    value={draft.opening}
                    onChange={(v) => setDraft(d => ({ ...d, opening: v }))}
                    onUpload={uploadInto('opening')}
                    placeholder="The character's first line, sets the scene…"
                    rows={6}
                />

                <div className='manage-form__actions'>
                    <button type='button' className='btn' onClick={cancel}>Cancel</button>
                    <button type='submit' className='btn btn--primary'>
                        <Icon name='save' /> Save
                    </button>
                </div>
            </form>
        )
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className='row' style={{ justifyContent: 'space-between' }}>
                <span className='section__title' style={{ margin: 0 }}>{characters.length} character{characters.length === 1 ? '' : 's'}</span>
                <button className='btn btn--primary' onClick={startNew}>
                    <Icon name='plus' /> New character
                </button>
            </div>
            {error && <div className='modal__error'>{error}</div>}
            <ul className='list'>
                {characters.length === 0 && <li className='list-empty'>No characters yet.</li>}
                {characters.map(c => (
                    <li key={c.id} className='list-item'>
                        <Avatar
                            src={`/api/characters/${c.id}/picture`}
                            version={c.last_update}
                            name={c.name}
                            size='sm'
                        />
                        <div className='list-item__body'>
                            <span className='list-item__name'>{c.name}</span>
                            {c.description && <span className='list-item__meta'>{c.description}</span>}
                        </div>
                        <div className='list-item__actions'>
                            <button className='btn btn--sm btn--icon' onClick={() => startEdit(c)} aria-label='Edit'><Icon name='edit' /></button>
                            <button className='btn btn--sm btn--icon btn--danger' onClick={() => remove(c)} aria-label='Delete'><Icon name='trash' /></button>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    )
}

export default CharactersTab
