import { useEffect, useState } from 'react'
import axios from 'axios'
import { useApp } from '../../context/AppContext'
import Icon from '../../components/Icon'

const blank = {
    openrouter: { api_key: '', has_api_key: false, api_key_preview: '' },
    agent:      { address: '', api_key: '', has_api_key: false, api_key_preview: '' },
}

/** Settings tab: per-user connections (BYOK).
 *
 * Link your OpenRouter account and your OpenScenes Agent here — these are
 * the platforms LLM dispatch can route through. The server masks API keys
 * on read and accepts partial PUTs; empty inputs use provider-specific
 * semantics (see the hint text below each field). */
function ConnectionsTab() {
    const { userId, currentUser } = useApp()
    const [draft, setDraft] = useState(null)
    const [saved, setSaved] = useState(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [info, setInfo] = useState('')

    function refresh() {
        if (userId == null) return
        return axios.get(`/api/users/${userId}/settings`)
            .then(response => {
                const incoming = {
                    openrouter: { api_key: '', ...response.data.openrouter },
                    agent:      { api_key: '', ...response.data.agent },
                }
                setSaved(incoming)
                setDraft(incoming)
            })
            .catch(err => setError(err.response?.data?.error || 'Could not load settings.'))
    }

    useEffect(() => { refresh() }, [userId])

    function update(section, field, value) {
        setInfo('')
        setDraft(d => ({ ...d, [section]: { ...d[section], [field]: value } }))
    }

    function save(e) {
        e.preventDefault()
        if (userId == null) return
        // Send only what the user actually touched — partial PUT.
        const payload = {}
        if (draft.openrouter.api_key) {
            payload.openrouter = { api_key: draft.openrouter.api_key }
        }
        const agentSection = {}
        if (draft.agent.address !== saved.agent.address) {
            agentSection.address = draft.agent.address
        }
        if (draft.agent.api_key !== '') {
            agentSection.api_key = draft.agent.api_key
        }
        if (Object.keys(agentSection).length > 0) payload.agent = agentSection

        if (Object.keys(payload).length === 0) {
            setInfo('Nothing to save.')
            return
        }

        setBusy(true)
        setError('')
        axios.put(`/api/users/${userId}/settings`, payload)
            .then(() => refresh())
            .then(() => setInfo('Saved.'))
            .catch(err => setError(err.response?.data?.error || 'Could not save settings.'))
            .finally(() => setBusy(false))
    }

    if (userId == null) {
        return <div className='list-empty'>Sign in as a user first to manage their settings.</div>
    }
    if (!draft) {
        return <div className='list-empty'>Loading…</div>
    }

    const openrouterPlaceholder = draft.openrouter.has_api_key
        ? `Current: ${draft.openrouter.api_key_preview || '…'} (leave blank to keep)`
        : 'sk-or-…'
    const agentKeyPlaceholder = draft.agent.has_api_key
        ? `Current: ${draft.agent.api_key_preview || '…'} (leave blank to clear)`
        : '(optional — only required if the agent has an API_KEY configured)'

    return (
        <form onSubmit={save} className='manage-form'>
            <div className='manage-form__header'>
                <h2 className='manage-form__title'>
                    {currentUser ? `Connections · ${currentUser.name}` : 'Connections'}
                </h2>
            </div>

            {error && <div className='modal__error'>{error}</div>}
            {info && <div className='field__hint'>{info}</div>}

            <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <span className='section__title' style={{ margin: 0 }}>OpenScenes Agent</span>

                <div className='field'>
                    <label className='field__label'>Address</label>
                    <input
                        className='input'
                        value={draft.agent.address}
                        onChange={(e) => update('agent', 'address', e.target.value)}
                        placeholder='http://127.0.0.1:8090'
                    />
                    <span className='field__hint'>
                        The base URL where your agent is reachable. Bare <code>host:port</code> works too.
                    </span>
                </div>

                <div className='field'>
                    <label className='field__label'>API key</label>
                    <input
                        className='input'
                        type='password'
                        value={draft.agent.api_key}
                        onChange={(e) => update('agent', 'api_key', e.target.value)}
                        placeholder={agentKeyPlaceholder}
                    />
                    <span className='field__hint'>
                        Empty input <strong>clears</strong> the stored key. Leave it blank if your agent has no <code>API_KEY</code> in its <code>config.ini</code>.
                    </span>
                </div>
            </section>

            <section style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
                <span className='section__title' style={{ margin: 0 }}>OpenRouter</span>

                <div className='field'>
                    <label className='field__label'>API key</label>
                    <input
                        className='input'
                        type='password'
                        value={draft.openrouter.api_key}
                        onChange={(e) => update('openrouter', 'api_key', e.target.value)}
                        placeholder={openrouterPlaceholder}
                    />
                    <span className='field__hint'>
                        Empty input <strong>keeps</strong> the existing key (clearing it bricks every OpenRouter LLM). To remove a key, delete and recreate.
                    </span>
                </div>
            </section>

            <div className='manage-form__actions'>
                <button type='submit' className='btn btn--primary' disabled={busy}>
                    <Icon name='save' /> {busy ? 'Saving…' : 'Save'}
                </button>
            </div>
        </form>
    )
}

export default ConnectionsTab
