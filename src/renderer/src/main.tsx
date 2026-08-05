import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startAttention, startPersistence, useDeck } from './store'
import { installVoiceCheck } from './voice'
import './styles.css'

const root = createRoot(document.getElementById('root')!)
root.render(<App />)

startPersistence()
startAttention()
installVoiceCheck()
void useDeck.getState().hydrate()
