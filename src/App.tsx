import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import Landing from './pages/Landing';
import MissionInput from './pages/MissionInput';
import Results from './pages/Results';
import FunderDetail from './pages/FunderDetail';
import SavedFunders from './pages/SavedFunders';
import NotFound from './pages/NotFound';

function App() {
  return (
    // AuthProvider must be inside BrowserRouter so it can use router hooks if needed,
    // but outside all Routes so every page has access to the auth context.
    <BrowserRouter basename="/funder-finder">
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/mission" element={<MissionInput />} />
          <Route path="/results" element={<Results />} />
          <Route path="/funder/:id" element={<FunderDetail />} />
          <Route path="/saved" element={<SavedFunders />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
