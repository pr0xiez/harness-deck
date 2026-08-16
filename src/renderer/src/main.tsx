import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startAttention, startPersistence, useDeck } from './store'
import { installVoiceCheck } from './voice'
import './styles.css'

// Chromium's default for a dropped file or link is to navigate the window to
// it, which would re-run the preload against foreign content. The main process
// blocks that navigation too; this stops the attempt before it starts.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

const root = createRoot(document.getElementById('root')!)
root.render(<App />)

startPersistence()
startAttention()
installVoiceCheck()
void useDeck.getState().hydrate()
