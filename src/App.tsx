import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import AnalyticsTracker from './components/AnalyticsTracker';
import AuthGuard from './components/AuthGuard';
import FeatureTooltips from './components/FeatureTooltip';
import Landing from './pages/Landing';
import MissionInput from './pages/MissionInput';
import Results from './pages/Results';
import FunderDetail from './pages/FunderDetail';
import SavedFunders from './pages/SavedFunders';
import GrantWriter from './pages/GrantWriter';
import OrgSearchPage from './pages/OrgSearchPage';
import RecipientProfile from './pages/RecipientProfile';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import DashboardPage from './pages/DashboardPage';
import NewProjectPage from './pages/NewProjectPage';
import ProjectWorkspace from './pages/ProjectWorkspace';
import BrowsePage from './pages/BrowsePage';
import UserSettingsPage from './pages/UserSettingsPage';
import PortfolioPage from './pages/PortfolioPage';
import MyTasksPage from './pages/MyTasksPage';
import TeamSettingsPage from './pages/TeamSettingsPage';
import SharedViewPage from './pages/SharedViewPage';
import ReportsPage from './pages/ReportsPage';
import ApplicationsPage from './pages/ApplicationsPage';
import OnboardingPage from './pages/OnboardingPage';
import NotFound from './pages/NotFound';
import BugReportButton from './components/BugReportButton';
import ThemeToggle from './components/ThemeToggle';

// Must match the key used in AuthContext.storePendingFunder
const REDIRECT_AFTER_LOGIN_KEY = 'ff_redirect_after_login';

// Wrap Routes in a component that reads location so we can key on pathname.
// Changing the key forces a remount, which re-triggers the CSS fade-in animation.
// Also handles post-login redirects (e.g. to /saved after a pending funder is auto-saved).
function AnimatedRoutes() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, postLoginRedirect, clearPostLoginRedirect } = useAuth();
  const prevUserRef = useRef(user);

  // Primary path: AuthContext sets postLoginRedirect after the DB save.
  useEffect(() => {
    if (postLoginRedirect) {
      sessionStorage.removeItem(REDIRECT_AFTER_LOGIN_KEY); // keep in sync with backup
      clearPostLoginRedirect();
      // pathname guard prevents a double push if the backup path already navigated here.
      if (location.pathname !== postLoginRedirect) {
        navigate(postLoginRedirect);
      }
    }
  }, [postLoginRedirect, clearPostLoginRedirect, navigate, location.pathname]);

  // Backup path: reads directly from sessionStorage when the user transitions
  // null → signed-in.  Fires even when the Supabase SIGNED_IN event was emitted
  // before any React subscriber was registered (Supabase v2 processes the OAuth
  // code during client initialisation, before useEffect runs).
  useEffect(() => {
    const wasSignedOut = prevUserRef.current === null;
    const isNowSignedIn = user !== null;
    prevUserRef.current = user;

    if (wasSignedOut && isNowSignedIn) {
      const redirectPath = sessionStorage.getItem(REDIRECT_AFTER_LOGIN_KEY);
      if (redirectPath) {
        sessionStorage.removeItem(REDIRECT_AFTER_LOGIN_KEY);
        // Push so the user can press Back and return to the landing page.
        if (location.pathname !== redirectPath) {
          navigate(redirectPath);
        }
      }
    }
  }, [user, navigate, location.pathname]);

  return (
    <main key={location.pathname} id="main-content" className="page-fade-in">
      <Routes location={location}>
        {/* Public routes */}
        <Route path="/" element={<Landing />} />
        <Route path="/mission" element={<MissionInput />} />
        <Route path="/results" element={<Results />} />
        <Route path="/funder/:id" element={<FunderDetail />} />
        <Route path="/saved" element={<SavedFunders />} />
        <Route path="/grant-writer" element={<GrantWriter />} />
        <Route path="/search" element={<OrgSearchPage />} />
        <Route path="/recipient/:id" element={<RecipientProfile />} />
        <Route path="/browse" element={<BrowsePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/find" element={<Navigate to="/mission" replace />} />

        {/* Auth-gated routes */}
        <Route path="/dashboard" element={<AuthGuard><DashboardPage /></AuthGuard>} />
        <Route path="/projects/new" element={<AuthGuard><NewProjectPage /></AuthGuard>} />
        <Route path="/projects/:id" element={<AuthGuard><ProjectWorkspace /></AuthGuard>} />
        <Route path="/projects/:id/matches" element={<AuthGuard><ProjectWorkspace /></AuthGuard>} />
        <Route path="/projects/:id/tracker" element={<AuthGuard><ProjectWorkspace /></AuthGuard>} />
        <Route path="/projects/:id/calendar" element={<AuthGuard><ProjectWorkspace /></AuthGuard>} />
        <Route path="/projects/:id/peers" element={<AuthGuard><ProjectWorkspace /></AuthGuard>} />
        <Route path="/projects/:id/settings" element={<AuthGuard><ProjectWorkspace /></AuthGuard>} />
        <Route path="/settings" element={<AuthGuard><UserSettingsPage /></AuthGuard>} />
        <Route path="/settings/team" element={<AuthGuard><TeamSettingsPage /></AuthGuard>} />
        <Route path="/settings/team/activity" element={<AuthGuard><TeamSettingsPage /></AuthGuard>} />
        <Route path="/portfolio" element={<AuthGuard><PortfolioPage /></AuthGuard>} />
        <Route path="/tasks" element={<AuthGuard><MyTasksPage /></AuthGuard>} />
        <Route path="/reports" element={<AuthGuard><ReportsPage /></AuthGuard>} />
        <Route path="/applications" element={<AuthGuard><ApplicationsPage /></AuthGuard>} />
        <Route path="/onboarding/welcome" element={<AuthGuard><OnboardingPage /></AuthGuard>} />
        <Route path="/onboarding/profile" element={<AuthGuard><OnboardingPage /></AuthGuard>} />
        <Route path="/onboarding/first-project" element={<AuthGuard><OnboardingPage /></AuthGuard>} />
        <Route path="/onboarding/matches" element={<AuthGuard><OnboardingPage /></AuthGuard>} />
        <Route path="/onboarding/save" element={<AuthGuard><OnboardingPage /></AuthGuard>} />

        {/* Public shared view (no auth required) */}
        <Route path="/shared/:token" element={<SharedViewPage />} />

        <Route path="*" element={<NotFound />} />
      </Routes>
    </main>
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
        <BugReportButton />
        <ThemeToggle />
        <FeatureTooltips />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
