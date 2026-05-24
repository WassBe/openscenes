import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import Navbar from './components/Navbar'
import Sidebar from './components/Sidebar'
import { Outlet } from 'react-router-dom'

/**
 * Top-level shell: navbar, collapsible sidebar, and the routed page slot.
 * Chat routes get a flush content area so the conversation can fill it.
 */
function App() {
    const location = useLocation()
    const isChat = location.pathname.startsWith('/chat/')
    const [sidebarOpen, setSidebarOpen] = useState(false)

    return (
        <div className='app'>
            <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
            <div className='app__main'>
                <Navbar onMenuClick={() => setSidebarOpen(true)} />
                <main className={`app__content${isChat ? ' app__content--flush' : ''}`}>
                    <Outlet />
                </main>
            </div>
        </div>
    )
}

export default App
