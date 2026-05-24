/** Client entry point: mounts the providers and the route tree. */
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import Home from './pages/Home'
import Search from './pages/Search'
import Manage from './pages/Manage'
import Settings from './pages/Settings'
import Chat from './pages/chat/Chat'
import Character from './pages/Character'
import { AppProvider } from './context/AppContext'
import { ThemeProvider } from './context/ThemeContext'

createRoot(document.getElementById('root')).render(
    <ThemeProvider>
        <BrowserRouter>
            <AppProvider>
                <Routes>
                    <Route element={<App />}>
                        <Route path='/' element={<Home />} />
                        <Route path='/search' element={<Search />} />
                        <Route path='/manage' element={<Manage />} />
                        <Route path='/settings' element={<Settings />} />
                        <Route path='/chat/:id' element={<Chat />} />
                        <Route path='/character/:id' element={<Character />} />
                    </Route>
                </Routes>
            </AppProvider>
        </BrowserRouter>
    </ThemeProvider>
)
