import { Link } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import Avatar from './Avatar'

/**
 * Slide-in left rail listing the user's recent chats, ordered by most
 * recent activity. ``isOpen`` controls visibility; ``onClose`` is
 * invoked on backdrop click or link selection.
 */
function Sidebar({ isOpen, onClose }) {
    const { latests } = useApp()

    const sorted = [...latests].sort((a, b) => b.last_update.localeCompare(a.last_update))

    return (
        <>
            {isOpen && <div className='sidebar__overlay' onClick={onClose} />}
            <aside className={`sidebar${isOpen ? ' is-open' : ''}`}>
                <div className='sidebar__brand'>
                    <span className='sidebar__brand-mark'>OS</span>
                    <span>OpenScenes</span>
                </div>

                <div className='sidebar__section'>
                    <span className='sidebar__section-title'>Recents</span>
                </div>

                <ul className='sidebar__history'>
                    {sorted.length === 0 && (
                        <li className='sidebar__empty'>No chats yet.</li>
                    )}
                    {sorted.map((latest) => (
                        <li key={latest.chat_id}>
                            <Link
                                className='sidebar__history-link'
                                to={`/chat/${latest.chat_id}`}
                                onClick={onClose}
                            >
                                <Avatar
                                    src={`/api/characters/${latest.id}/picture`}
                                    version={latest.last_update}
                                    name={latest.name}
                                    size='sm'
                                />
                                <span>{latest.name}</span>
                            </Link>
                        </li>
                    ))}
                </ul>
            </aside>
        </>
    )
}

export default Sidebar
