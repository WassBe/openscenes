import { useEffect, useState } from 'react'
import axios from 'axios'
import { useApp } from '../../context/AppContext'
import Icon from '../../components/Icon'

/** Settings tab: per-user connections (BYOK).
 *
 * Renders one credential section per provider returned by ``/api/providers``.
 * The agent section is special (address + api_key); all other providers only
 * need an API key. Sections are populated server-side from ``PROVIDER_REGISTRY``
 * so adding a provider to the backend automatically surfaces it here. */
function ConnectionsTab() {
    const { userId, currentUser } = useApp()
    const [providers, setProviders] = useState([])
    const [draft, setDraft] = useState(null)
    const [saved, setSaved] = useState(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [info, setInfo] = useState('')

    function refresh() {
        if (userId == null) return Promise.resolve()
        return axios.get(`/api/users/${userId}/settings`)
            .then(response => {
                const incoming = {}
                for (const [key, val] of Object.entries(response.data)) {
                    incoming[key] = { api_key: '', ...val }
                }
                setSaved(incoming)
                setDraft(incoming)
            })
            .catch(err => setError(err.response?.data?.error || 'Could not load settings.'))
    }

    useEffect(() => {
        if (userId == null) return
        Promise.all([
            axios.get('/api/providers'),
            axios.get(`/api/users/${userId}/settings`),
        ]).then(([provRes, settRes]) => {
            setProviders(provRes.data)
            const incoming = {}
            for (const [key, val] of Object.entries(settRes.data)) {
                incoming[key] = { api_key: '', ...val }
            }
            setSaved(incoming)
            setDraft(incoming)
        }).catch(err => setError(err.response?.data?.error || 'Could not load settings.'))
    }, [userId])

    function update(section, field, value) {
        setInfo('')
        setDraft(d => ({ ...d, [section]: { ...d[section], [field]: value } }))
    }

    function save(e) {
        e.preventDefault()
        if (userId == null) return
        const payload = {}

        // Registry providers — each only has an api_key; empty keeps the existing value.
        for (const p of providers) {
            if (p.id === 'agent') continue
            const key = draft[p.id]?.api_key
            if (key) payload[p.id] = { api_key: key }
        }

        // Agent — address and api_key have their own semantics (empty api_key clears it).
        const agentSection = {}
        if (draft.agent?.address !== saved.agent?.address) {
            agentSection.address = draft.agent.address
        }
        if (draft.agent?.api_key !== '') {
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

    const agentKeyPlaceholder = draft.agent?.has_api_key
        ? `Current: ${draft.agent.api_key_preview || '…'} (leave blank to clear)`
        : '(optional — only required if the agent has an API_KEY configured)'

    // Registry providers (everything except agent), in registry order.
    const registryProviders = providers.filter(p => p.id !== 'agent')

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
                        value={draft.agent?.address || ''}
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
                        value={draft.agent?.api_key || ''}
                        onChange={(e) => update('agent', 'api_key', e.target.value)}
                        placeholder={agentKeyPlaceholder}
                    />
                    <span className='field__hint'>
                        Empty input <strong>clears</strong> the stored key. Leave it blank if your agent has no <code>API_KEY</code> in its <code>config.ini</code>.
                    </span>
                </div>
            </section>

            {registryProviders.map(p => {
                const section = draft[p.id] || {}
                const placeholder = section.has_api_key
                    ? `Current: ${section.api_key_preview || '…'} (leave blank to keep)`
                    : 'sk-…'
                return (
                    <section key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
                        <span className='section__title' style={{ margin: 0 }}>{p.label}</span>

                        <div className='field'>
                            <label className='field__label'>API key</label>
                            <input
                                className='input'
                                type='password'
                                value={section.api_key || ''}
                                onChange={(e) => update(p.id, 'api_key', e.target.value)}
                                placeholder={placeholder}
                            />
                            <span className='field__hint'>
                                Empty input <strong>keeps</strong> the existing key.
                            </span>
                        </div>
                    </section>
                )
            })}

            <div className='manage-form__actions'>
                <button type='submit' className='btn btn--primary' disabled={busy}>
                    <Icon name='save' /> {busy ? 'Saving…' : 'Save'}
                </button>
            </div>
        </form>
    )
}

export default ConnectionsTab
