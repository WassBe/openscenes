import { Link } from 'react-router-dom'
import { useState } from 'react'
import { useApp } from '../context/AppContext'
import Avatar from '../components/Avatar'
import Icon from '../components/Icon'

/** Character search page: filters the catalogue by name or description. */
function Search() {
    const { characters } = useApp()
    const [search, setSearch] = useState('')

    const needle = search.trim().toLowerCase()
    const filtered = needle === ''
        ? characters
        : characters.filter(c =>
            c.name.toLowerCase().includes(needle) ||
            (c.description || '').toLowerCase().includes(needle)
        )

    return (
        <>
            <header className='page-header'>
                <div>
                    <h1 className='page-header__title'>Search</h1>
                    <p className='page-header__subtitle'>Find a character to chat with.</p>
                </div>
            </header>

            <div style={{ position: 'relative', maxWidth: 480, marginBottom: 24 }}>
                <Icon
                    name='search'
                    className='icon'
                    style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-subtle)' }}
                />
                <input
                    className='input input--lg'
                    style={{ paddingLeft: 36 }}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder='Search by name or description…'
                />
            </div>

            {filtered.length === 0 ? (
                <div className='list-empty'>
                    {characters.length === 0 ? 'No characters yet.' : 'No matches.'}
                </div>
            ) : (
                <div className='character-grid'>
                    {filtered.map((character) => (
                        <Link key={character.id} to={`/character/${character.id}`} className='card-link'>
                            <article className='card character-card'>
                                <Avatar
                                    src={`/api/characters/${character.id}/picture`}
                                    version={character.last_update}
                                    name={character.name}
                                    size='lg'
                                />
                                <div className='character-card__body'>
                                    <span className='character-card__name'>{character.name}</span>
                                    {character.description && (
                                        <span className='character-card__description'>{character.description}</span>
                                    )}
                                </div>
                            </article>
                        </Link>
                    ))}
                </div>
            )}
        </>
    )
}

export default Search
