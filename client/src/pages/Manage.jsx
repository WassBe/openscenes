import { useState } from 'react'
import { useApp } from '../context/AppContext'
import CharactersTab from './manage/CharactersTab'
import StylesTab from './manage/StylesTab'

const TABS = [
    { id: 'characters', label: 'Characters' },
    { id: 'styles',     label: 'Chat styles' },
]

/** Admin page with tabs for shared content: characters and chat styles. */
function Manage() {
    const { characters, styles } = useApp()
    const [tab, setTab] = useState('characters')

    const counts = { characters: characters.length, styles: styles.length }

    return (
        <div className='manage'>
            <header className='page-header'>
                <div>
                    <h1 className='page-header__title'>Manage</h1>
                    <p className='page-header__subtitle'>Characters and chat styles shared across users.</p>
                </div>
            </header>

            <div className='tabs'>
                {TABS.map(t => (
                    <button
                        key={t.id}
                        className={`tab${tab === t.id ? ' is-active' : ''}`}
                        onClick={() => setTab(t.id)}
                    >
                        {t.label}{counts[t.id] !== undefined && ` · ${counts[t.id]}`}
                    </button>
                ))}
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
                {tab === 'characters' && <CharactersTab />}
                {tab === 'styles' && <StylesTab />}
            </div>
        </div>
    )
}

export default Manage
