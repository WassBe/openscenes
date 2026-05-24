import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import axios from 'axios'
import ReactMarkdown from 'react-markdown'
import { useApp } from '../context/AppContext'
import Avatar from '../components/Avatar'
import Icon from '../components/Icon'

/**
 * Character profile page. Shows description and context, and offers a
 * button to start (or resume) a chat with the active user.
 */
function Character() {
    const { id: rawId } = useParams()
    const characterId = Number(rawId)
    const navigate = useNavigate()
    const { userId, personaId, fetchChats } = useApp()

    const [character, setCharacter] = useState(null)
    const [error, setError] = useState('')

    useEffect(() => {
        axios.get(`/api/characters/${characterId}`)
            .then(response => setCharacter(response.data))
            .catch(err => setError(err.response?.data?.error || 'Character not found.'))
    }, [characterId])

    function startChat() {
        if (userId === null) { alert('Sign in first.'); return }
        axios.post(`/api/chats/${userId}/start`, {
                character_id: characterId,
                persona_id: personaId
            })
            .then(response => {
                fetchChats()
                navigate(`/chat/${response.data.id}`)
            })
            .catch(err => alert(err.response?.data?.error || 'Could not start chat.'))
    }

    if (error) return <div className='profile'><div className='modal__error'>{error}</div></div>
    if (!character) return null

    return (
        <div className='profile'>
            <div className='profile__header'>
                <Avatar
                    src={`/api/characters/${character.id}/picture`}
                    version={character.last_update}
                    name={character.name}
                    size='xl'
                />
                <div className='profile__meta'>
                    <h1 className='profile__name'>{character.name}</h1>
                    {character.description && (
                        <p className='profile__description'>{character.description}</p>
                    )}
                    <div className='profile__actions'>
                        <button className='btn btn--primary' onClick={startChat}>
                            <Icon name='chat' /> Start chat
                        </button>
                    </div>
                </div>
            </div>

            {character.description && (
                <section className='profile__section'>
                    <h2>Description</h2>
                    <div className='markdown'>
                        <ReactMarkdown>{character.description}</ReactMarkdown>
                    </div>
                </section>
            )}

            {character.context && (
                <section className='profile__section'>
                    <h2>Context</h2>
                    <div className='markdown'>
                        <ReactMarkdown>{character.context}</ReactMarkdown>
                    </div>
                </section>
            )}
        </div>
    )
}

export default Character
