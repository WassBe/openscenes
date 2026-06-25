import { useEffect, useState } from 'react'
import axios from 'axios'
import { useApp } from '../../context/AppContext'
import Icon from '../../components/Icon'

/** Settings tab: CRUD for LLM entries. Entries are per-user pure labels of
 * ``{name, model, provider}`` — ``name`` is a free display label, ``model`` is
 * the provider's model identifier; connection credentials (API keys, agent
 * address) live in the Connections tab. */
function LlmsTab() {
    const { userId } = useApp()
    const [providers, setProviders] = useState([])
    const [llms, setLlms] = useState([])
    const [draft, setDraft] = useState(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    const providerMap = Object.fromEntries(providers.map(p => [p.id, p]))

    function refresh() {
        if (userId == null) return Promise.resolve()
        return axios.get(`/api/users/${userId}/llms`)
            .then(response => setLlms(response.data))
            .catch(err => setError(err.response?.data?.error || 'Could not load LLMs.'))
    }

    useEffect(() => {
        axios.get('/api/providers')
            .then(res => setProviders(res.data))
            .catch(() => {})
    }, [])

    useEffect(() => { refresh() }, [userId])

    function startNew() {
        setDraft({ id: null, name: '', model: '', provider: 'agent' })
        setError('')
    }

    function startEdit(llm) {
        if (userId == null) return
        axios.get(`/api/users/${userId}/llms/${llm.id}`)
            .then(response => setDraft({
                id: response.data.id,
                name: response.data.name || '',
                model: response.data.model || '',
                provider: response.data.provider,
            }))
            .catch(err => setError(err.response?.data?.error || 'Could not load LLM.'))
    }

    function cancel() { setDraft(null); setError('') }

    function save(e) {
        e.preventDefault()
        if (userId == null) return
        if (!draft.name.trim()) { setError('Name required.'); return }
        if (!draft.model.trim()) { setError('Model required.'); return }
        const isNew = draft.id == null
        setBusy(true)

        const payload = isNew
            ? { name: draft.name.trim(), model: draft.model.trim(), provider: draft.provider }
            : { name: draft.name.trim(), model: draft.model.trim() }

        const req = isNew
            ? axios.post(`/api/users/${userId}/llms`, payload)
            : axios.put(`/api/users/${userId}/llms/${draft.id}`, payload)

        req
            .then(() => refresh())
            .then(() => { setDraft(null); setError('') })
            .catch(err => setError(err.response?.data?.error || 'Could not save LLM.'))
            .finally(() => setBusy(false))
    }

    function remove(llm) {
        if (userId == null) return
        if (!confirm(`Delete LLM "${llm.name}"?`)) return
        axios.delete(`/api/users/${userId}/llms/${llm.id}`)
            .then(() => refresh())
            .catch(err => setError(err.response?.data?.error || 'Could not delete LLM.'))
    }

    if (userId == null) {
        return <div className='list-empty'>Sign in as a user first to manage their LLMs.</div>
    }

    if (draft) {
        const isNew = draft.id == null
        const selectedProvider = providerMap[draft.provider]
        const modelPlaceholder = draft.provider === 'agent'
            ? 'e.g. Meta-Llama-3.1-8B-Instruct-Q4_K_M'
            : 'e.g. anthropic/claude-3.5-sonnet'
        const modelHint = draft.provider === 'agent'
            ? 'The model name as registered on the agent.'
            : `The model identifier for ${selectedProvider?.label || 'the selected provider'}.`

        return (
            <form onSubmit={save} className='manage-form'>
                <div className='manage-form__header'>
                    <h2 className='manage-form__title'>
                        {isNew ? 'New LLM' : (draft.name || '(unnamed)')}
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
                        placeholder='e.g. Claude 3.5 (OpenRouter)'
                    />
                    <span className='field__hint'>
                        A label to recognize this entry — handy when the same model runs on several providers.
                    </span>
                </div>

                <div className='field'>
                    <label className='field__label'>Model</label>
                    <input
                        className='input'
                        value={draft.model}
                        onChange={(e) => setDraft(d => ({ ...d, model: e.target.value }))}
                        placeholder={modelPlaceholder}
                    />
                    <span className='field__hint'>{modelHint}</span>
                </div>

                <div className='field'>
                    <label className='field__label'>Provider</label>
                    {isNew ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {providers.map(p => (
                                <label key={p.id} className='row' style={{ gap: 10, cursor: 'pointer' }}>
                                    <input
                                        type='radio'
                                        name='provider'
                                        value={p.id}
                                        checked={draft.provider === p.id}
                                        onChange={() => setDraft(d => ({ ...d, provider: p.id }))}
                                    />
                                    <span><strong>{p.label}</strong> <span className='field__hint'>— {p.hint}</span></span>
                                </label>
                            ))}
                        </div>
                    ) : (
                        <input className='input' value={selectedProvider?.label || draft.provider} disabled />
                    )}
                </div>

                <div className='field__hint' style={{ marginTop: 8 }}>
                    Credentials (API keys, Agent address) live in the <strong>Connections</strong> tab.
                </div>

                <div className='manage-form__actions'>
                    <button type='button' className='btn' onClick={cancel}>Cancel</button>
                    <button type='submit' className='btn btn--primary' disabled={busy}>
                        <Icon name='save' /> {busy ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </form>
        )
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className='row' style={{ justifyContent: 'space-between' }}>
                <span className='section__title' style={{ margin: 0 }}>{llms.length} LLM{llms.length === 1 ? '' : 's'}</span>
                <button className='btn btn--primary' onClick={startNew}>
                    <Icon name='plus' /> New LLM
                </button>
            </div>
            {error && <div className='modal__error'>{error}</div>}
            <ul className='list'>
                {llms.length === 0 && <li className='list-empty'>No LLMs yet — create one above.</li>}
                {llms.map(l => (
                    <li key={l.id} className='list-item'>
                        <div className='list-item__body'>
                            <span className='list-item__name'>{l.name}</span>
                            <span className='list-item__meta'>
                                {l.model} · {providerMap[l.provider]?.label || l.provider}
                            </span>
                        </div>
                        <div className='list-item__actions'>
                            <button className='btn btn--sm btn--icon' onClick={() => startEdit(l)} aria-label='Edit'><Icon name='edit' /></button>
                            <button className='btn btn--sm btn--icon btn--danger' onClick={() => remove(l)} aria-label='Delete'><Icon name='trash' /></button>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    )
}

export default LlmsTab
