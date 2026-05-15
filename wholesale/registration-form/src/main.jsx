import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App.jsx'
const container = document.getElementById('react-root');

if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(<App />);
}
