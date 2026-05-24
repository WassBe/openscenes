import { useState } from 'react'
import axios from 'axios'
import { useApp } from '../../context/AppContext'
import Icon from '../../components/Icon'

const blank = { id: null, name: '', description: '', rules: '' }

/** Manage tab: CRUD for chat styles (name + description + rules markdown).
 * Chat styles are pure rules wrappers — the LLM dispatched against is owned
 * by the chat session, not the style. */
function StylesTab() {
    const { styles, fetchStyles } = useApp()
    const [draft, setDraft] = useState(null)
    const [error, setError] = useState('')

    function startNew() { setDraft({ ...blank }); setError('') }

    function startEdit(style) {
        axios.get(`/api/styles/${style.id}`)
            .then(response => setDraft({
                id: response.data.id,
                name: response.data.name || '',
                description: response.data.description || '',
                rules: response.data.rules || ''
            }))
            .catch(err => setError(err.response?.data?.error || 'Could not load chat style.'))
    }

    function cancel() { setDraft(null); setError('') }

    function save(e) {
        e.preventDefault()
        if (!draft.name.trim()) { setError('Name required.'); return }

        const payload = {
            name: draft.name.trim(),
            description: draft.description,
            rules: draft.rules
        }

        const req = draft.id == null
            ? axios.post('/api/styles', payload)
            : axios.put(`/api/styles/${draft.id}`, payload)

        req
            .then(() => fetchStyles())
            .then(() => { setDraft(null); setError('') })
            .catch(err => setError(err.response?.data?.error || 'Could not save chat style.'))
    }

    function remove(style) {
        if (!confirm(`Delete chat style "${style.name}"? This removes its rules file.`)) return
        axios.delete(`/api/styles/${style.id}`)
            .then(() => fetchStyles())
            .catch(err => setError(err.response?.data?.error || 'Could not delete chat style.'))
    }

    function duplicate(style) {
        // Server clones the entry + rules with a unique " (copy)" name; we then
        // open the clone in the edit form so tweaks can be made immediately.
        axios.post(`/api/styles/${style.id}/duplicate`)
            .then(response => fetchStyles().then(() => startEdit(response.data)))
            .catch(err => setError(err.response?.data?.error || 'Could not duplicate chat style.'))
    }

    function uploadRules(e) {
        const file = e.target.files[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = (ev) => setDraft(d => ({ ...d, rules: ev.target.result }))
        reader.readAsText(file)
        e.target.value = ''
    }

    if (draft) {
        return (
            <form onSubmit={save} className='manage-form'>
                <div className='manage-form__header'>
                    <h2 className='manage-form__title'>
                        {draft.id == null ? 'New chat style' : (draft.name || '(unnamed)')}
                    </h2>
                    <button type='button' className='btn' onClick={cancel}>Cancel</button>
                </div>
                {error && <div className='modal__error'>{error}</div>}

                <div className='field'>
                    <label className='field__label'>Name</label>
                    <input
                        className='input'
                        autoFocus
                        value={draft.name}
                        onChange={(e) => setDraft(d => ({ ...d, name: e.target.value }))}
                        placeholder='e.g. roleplay'
                    />
                </div>

                <div className='field'>
                    <label className='field__label'>Description</label>
                    <input
                        className='input'
                        value={draft.description}
                        onChange={(e) => setDraft(d => ({ ...d, description: e.target.value }))}
                        placeholder='short summary shown in lists'
                    />
                </div>

                <div className='field'>
                    <label className='field__label'>Rules (markdown)</label>
                    <div className='upload-row'>
                        <label className='upload'>
                            <Icon name='upload' /> Upload .md
                            <input type='file' accept='.md,.txt,text/markdown,text/plain' onChange={uploadRules} hidden />
                        </label>
                        <span className='field__hint'>…or write below.</span>
                    </div>
                    <textarea
                        className='textarea'
                        rows={18}
                        value={draft.rules}
                        onChange={(e) => setDraft(d => ({ ...d, rules: e.target.value }))}
                        placeholder='System rules / behavior guidelines for this chat style…'
                    />
                </div>

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
                <span className='section__title' style={{ margin: 0 }}>{styles.length} chat style{styles.length === 1 ? '' : 's'}</span>
                <button className='btn btn--primary' onClick={startNew}>
                    <Icon name='plus' /> New chat style
                </button>
            </div>
            {error && <div className='modal__error'>{error}</div>}
            <ul className='list'>
                {styles.length === 0 && <li className='list-empty'>No chat styles yet.</li>}
                {styles.map(s => (
                    <li key={s.id} className='list-item'>
                        <div className='list-item__body'>
                            <span className='list-item__name'>{s.name}</span>
                            {s.description && <span className='list-item__meta'>{s.description}</span>}
                        </div>
                        <div className='list-item__actions'>
                            <button className='btn btn--sm btn--icon' onClick={() => duplicate(s)} aria-label='Duplicate'><Icon name='copy' /></button>
                            <button className='btn btn--sm btn--icon' onClick={() => startEdit(s)} aria-label='Edit'><Icon name='edit' /></button>
                            <button className='btn btn--sm btn--icon btn--danger' onClick={() => remove(s)} aria-label='Delete'><Icon name='trash' /></button>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    )
}

export default StylesTab
