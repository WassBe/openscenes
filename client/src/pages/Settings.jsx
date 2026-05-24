import { useState } from 'react'
import LlmsTab from './settings/LlmsTab'
import ConnectionsTab from './settings/ConnectionsTab'

const TABS = [
    { id: 'llms',        label: 'LLMs' },
    { id: 'connections', label: 'Connections' },
]

/** Per-user settings page: pick which LLMs you can dispatch against, and
 * link the platforms they route through (OpenRouter, the OpenScenes Agent). */
function Settings() {
    const [tab, setTab] = useState('llms')

    return (
        <div className='manage'>
            <header className='page-header'>
                <div>
                    <h1 className='page-header__title'>Settings</h1>
                    <p className='page-header__subtitle'>Your LLM labels and the platforms they route through.</p>
                </div>
            </header>

            <div className='tabs'>
                {TABS.map(t => (
                    <button
                        key={t.id}
                        className={`tab${tab === t.id ? ' is-active' : ''}`}
                        onClick={() => setTab(t.id)}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
                {tab === 'llms' && <LlmsTab />}
                {tab === 'connections' && <ConnectionsTab />}
            </div>
        </div>
    )
}

export default Settings
