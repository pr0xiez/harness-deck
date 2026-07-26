import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startPersistence, useDeck } from './store'
import './styles.css'

const root = createRoot(document.getElementById('root')!)
root.render(<App />)

startPersistence()
void useDeck.getState().hydrate()
