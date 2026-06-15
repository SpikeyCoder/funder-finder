import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { Suspense, lazy, useEffect, useRef } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import AnalyticsTracker from './components/AnalyticsTracker';
import AuthGuard from './components/AuthGuard';
import FeatureTooltips from './components/FeatureTooltip';
import BugReportButton from './components/BugReportButton';
import ThemeToggle from './components/ThemeToggle';
import ErrorBoundary from './components/ErrorBoundary';

// Must match the key used in AuthContext.storePendingFunder
const REDIRECT_AFTER_LOGIN_KEY = 'ff_redirect_after_login';

const Landing = lazy(() => import('./pages/Landing'));
const MissionInput = lazy(() => import('./pages/MissionInput'));
const Results = lazy(() => import('./pages/Results'));
const FunderDetail = lazy(() => import('./pages/FunderDetail'));
const SavedFunders = lazy(() => import('./pages/SavedFunders'));
const GrantWriter = lazy(() => import('./pages/GrantWriter'));
const OrgSearchPage = lazy(() => import('./pages/OrgSearchPage'));
const RecipientProfile = lazy(() => import('./pages/RecipientProfile'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const SignupPage = lazy(() => import('./pages/SignupPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const NewProjectPage = lazy(() => import('./pages/NewProjectPage'));
const ConversationalProjectSetup = lazy(() => import('./pages/ConversationalProjectSetup'));
const ProjectWorkspace = lazy(() => import('./pages/ProjectWorkspace'));
const BrowsePage = lazy(() => import('./pages/BrowsePage'));
const UserSettingsPage = lazy(() => import('./pages/UserSettingsPage'));
const PortfolioPage = lazy(() => import('./pages/PortfolioPage'));
const MyTasksPage = lazy(() => import('./pages/MyTasksPage'));
const TeamSettingsPage = lazy(() => import('./pages/TeamSettingsPage'));
const SharedViewPage = lazy(() => import('./pages/SharedViewPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const ApplicationsPage = lazy(() => import('./pages/ApplicationsPage'));
const MigrationImportPage = lazy(() => import('./pages/MigrationImportPage'));
const OnboardingPage = lazy(() => import('./pages/OnboardingPage'));
const NotFound = lazy(() => import('./pages/NotFound'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const ContactPage = lazy(() => import('./pages/ContactPage'));
const TermsOfService = lazy(() => import('./pages/TermsOfService'));
const ApiDocsPage = lazy(() => import('./pages/ApiDocsPage'));

const RouteFallback = () => (
  <div className="min-h-[40vh] flex items-center justify-center text-gray-400 text-sm">
    Loading...
  </div>
);

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
    <div key={location.pathname} className="page-fade-in">
      <ErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
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
          <Route path="/docs/api" element={<ApiDocsPage />} />

          {/* Auth-gated routes */}
          <Route path="/dashboard" element={<AuthGuard><DashboardPage /></AuthGuard>} />
          <Route path="/projects/new" element={<AuthGuard><NewProjectPage /></AuthGuard>} />
          <Route path="/projects/new/chat" element={<AuthGuard><ConversationalProjectSetup /></AuthGuard>} />
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
          <Route path="/import" element={<AuthGuard><MigrationImportPage /></AuthGuard>} />
          <Route path="/onboarding/welcome" element={<AuthGuard><OnboardingPage /></AuthGuard>} />
          <Route path="/onboarding/profile" element={<AuthGuard><OnboardingPage /></AuthGuard>} />
          <Route path="/onboarding/first-project" element={<AuthGuard><OnboardingPage /></AuthGuard>} />
          <Route path="/onboarding/matches" element={<AuthGuard><OnboardingPage /></AuthGuard>} />
          <Route path="/onboarding/save" element={<AuthGuard><OnboardingPage /></AuthGuard>} />

          {/* Public shared view (no auth required) */}
          <Route path="/shared/:token" element={<SharedViewPage />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/terms" element={<TermsOfService />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      </ErrorBoundary>
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
        <BugReportButton />
        <FeatureTooltips />
        <ThemeToggle />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
