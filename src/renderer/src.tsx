import React from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import { PresenterApp } from './presenter'
import { SetupApp } from './setup'

// Both windows load this entry; the main process picks the view.
const view = new URLSearchParams(window.location.search).get('view') === 'presenter' ? 'presenter' : 'setup'
document.documentElement.dataset.view = view
const rootElement = document.getElementById('root')
if (rootElement) createRoot(rootElement).render(<React.StrictMode>{view === 'presenter' ? <PresenterApp /> : <SetupApp />}</React.StrictMode>)
