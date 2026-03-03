import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import AnalyticsTracker from './components/AnalyticsTracker';
import Landing from './pages/Landing';
import MissionInput from './pages/MissionInput';
import Results from './pages/Results';
import FunderDetail from './pages/FunderDetail';
import SavedFunders from './pages/SavedFunders';
import GrantWriter from './pages/GrantWriter';
import NotFound from './pages/NotFound';

// Wrap Routes in a component that reads location so we can key on pathname.
// Changing the key forces a remount, which re-triggers the CSS fade-in animation.
function AnimatedRoutes() {
  const location = useLocation();
  return (
    <div key={location.pathname} className="page-fade-in">
      <Routes location={location}>
        <Route path="/" element={<Landing />} />
        <Route path="/mission" element={<MissionInput />} />
        <Route path="/results" element={<Results />} />
        <Route path="/funder/:id" element={<FunderDetail />} />
        <Route path="/saved" element={<SavedFunders />} />
        <Route path="/grant-writer" element={<GrantWriter />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </div>
  );
}

function App() {
  return (
    // AuthProvider must be inside BrowserRouter so it can use router hooks if needed,
    // but outside all Routes so every page has access to the auth context.
    <BrowserRouter>
      <AnalyticsTracker />
      <AuthProvider>
        <AnimatedRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
