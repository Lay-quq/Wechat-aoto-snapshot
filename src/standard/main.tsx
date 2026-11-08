import React from 'react'
import { createRoot } from 'react-dom/client'
import { StandardApp } from './StandardApp'
import './Standard.scss'
import ErrorLogProvider from '../components/ErrorLogProvider'
import { ErrorBoundary } from '../components/ErrorBoundary'
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><ErrorLogProvider><StandardApp/></ErrorLogProvider></ErrorBoundary></React.StrictMode>)
