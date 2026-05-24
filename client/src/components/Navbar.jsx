import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useTheme } from '../context/ThemeContext'
import SessionModal from './SessionModal'
import Avatar from './Avatar'
import Icon from './Icon'

/**
 * Top header: nav links, theme toggle, and the session chip that opens
 * the user / persona modal. ``onMenuClick`` toggles the sidebar on mobile.
 */
function Navbar({ onMenuClick }) {
    const { currentUser } = useApp()
    const { theme, toggle } = useTheme()
    const [open, setOpen] = useState(false)

    const navClass = ({ isActive }) => `navbar__link${isActive ? ' is-active' : ''}`

    return (
        <>
            <header className='navbar'>
                <div className='navbar__left'>
                    <button
                        className='btn btn--ghost btn--icon navbar__menu-btn'
                        onClick={onMenuClick}
                        aria-label='Open navigation menu'
                    >
                        <Icon name='menu' />
                    </button>
                    <nav className='navbar__nav'>
                        <NavLink end to='/' className={navClass}>Home</NavLink>
                        <NavLink to='/search' className={navClass}>Search</NavLink>
                        <NavLink to='/manage' className={navClass}>Manage</NavLink>
                        <NavLink to='/settings' className={navClass}>Settings</NavLink>
                    </nav>
                </div>

                <div className='navbar__right'>
                    <button
                        className='btn btn--ghost btn--icon'
                        onClick={toggle}
                        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
                        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
                    >
                        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
                    </button>

                    <button className='session-chip' onClick={() => setOpen(true)}>
                        <div className='session-chip__avatar'>
                            {currentUser ? (
                                <Avatar
                                    src={`/api/users/${currentUser.id}/picture`}
                                    version={currentUser.reg_date}
                                    name={currentUser.name}
                                    size='sm'
                                />
                            ) : (
                                <div className='session-chip__avatar-placeholder'>
                                    <Icon name='user' className='icon' />
                                </div>
                            )}
                        </div>
                        <div className='session-chip__info'>
                            <span className='session-chip__label'>
                                {currentUser ? currentUser.name : 'Guest'}
                            </span>
                            <span className='session-chip__sublabel'>
                                {currentUser ? 'Session' : 'Sign in'}
                            </span>
                        </div>
                    </button>
                </div>
            </header>

            {open && <SessionModal onClose={() => setOpen(false)} />}
        </>
    )
}

export default Navbar
