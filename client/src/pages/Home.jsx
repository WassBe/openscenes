import { Link } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import Avatar from '../components/Avatar'

/** Tile linking to a character or chat, used in both grids on this page. */
function CharacterCard({ character, to, version }) {
    return (
        <Link to={to} className='card-link'>
            <article className='card character-card'>
                <Avatar
                    src={`/api/characters/${character.id}/picture`}
                    version={version}
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
    )
}

/** Landing page: recent chats followed by the full character catalogue. */
function Home() {
    const { latests, characters } = useApp()

    const recents = [...latests].sort((a, b) => b.last_update.localeCompare(a.last_update))

    return (
        <>
            <header className='page-header'>
                <div>
                    <h1 className='page-header__title'>Welcome back</h1>
                    <p className='page-header__subtitle'>Pick up a conversation or discover a new character.</p>
                </div>
            </header>

            {recents.length > 0 && (
                <section className='section'>
                    <h2 className='section__title'>Recent chats</h2>
                    <div className='character-grid'>
                        {recents.map((latest) => (
                            <CharacterCard
                                key={latest.chat_id}
                                character={latest}
                                version={latest.last_update}
                                to={`/chat/${latest.chat_id}`}
                            />
                        ))}
                    </div>
                </section>
            )}

            <section className='section'>
                <h2 className='section__title'>Discover</h2>
                {characters.length === 0 ? (
                    <div className='list-empty'>No characters yet — head to Manage to create one.</div>
                ) : (
                    <div className='character-grid'>
                        {characters.map((character) => (
                            <CharacterCard
                                key={character.id}
                                character={character}
                                version={character.last_update}
                                to={`/character/${character.id}`}
                            />
                        ))}
                    </div>
                )}
            </section>
        </>
    )
}

export default Home
