import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/app.css';

// Bootstrap the voice-commands library — these IIFEs attach the public API
// to window.WemoVoice / window.WemoVoiceTrainer.  Imported here so Vite
// inlines them into the renderer bundle, keeping the strict CSP happy
// (default-src 'self' rules out external <script> tags).
import './voice/voice-commands.js';
import './voice/voice-trainer.js';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
