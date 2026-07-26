import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startPersistence, useDeck } from './store'
import { installVoiceCheck } from './voice'
import './styles.css'

const root = createRoot(document.getElementById('root')!)
root.render(<App />)

startPersistence()
installVoiceCheck()
void useDeck.getState().hydrate()
