import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Feed } from './pages/Feed';
import { Login } from './pages/Login';
import './styles.css';

function App() {
  const page = window.location.pathname.replace(/\/+$/, '').endsWith('/login') ? 'login' : 'feed';
  return page === 'login' ? <Login /> : <Feed />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
