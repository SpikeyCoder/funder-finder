import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

interface AuthGuardProps {
  children: React.ReactNode;
}

/**
 * FM-2026-07-29-07: only ever persist a same-origin, single-segment-rooted path
 * for the post-login redirect.
 *
 * `location.pathname` is not automatically safe to hand back to navigate().
 * Visiting `https://fundermatch.org//evil.com` yields a pathname of literally
 * `//evil.com`, and `/\evil.com` yields `/\evil.com` — both of which a router
 * can treat as protocol-relative and follow OFF-SITE after the user logs in.
 * That is precisely the open redirect described by GHSA-wrjc-x8rr-h8h6 and
 * GHSA-jjmj-jmhj-qwj2, reachable here because this value is stored while
 * unauthenticated and replayed through navigate() immediately after sign-in.
 *
 * The react-router v7.18 upgrade fixes the library side. This is defence in
 * depth so the app does not depend on the router alone to refuse a hostile
 * target — and so a future router regression cannot silently reopen it.
 */
function safeRedirectPath(pathname: string): string {
  // Must be rooted, and must not begin a scheme-relative or backslash-escaped
  // authority. Anything else falls back to the default landing page.
  if (!pathname.startsWith('/')) return '/portfolio';
  if (pathname.startsWith('//') || pathname.startsWith('/\\')) return '/portfolio';
  return pathname;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading } = useAuth();
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    // Wait for auth loading to complete
    if (!loading) {
      if (!user) {
        // Save the current location for redirect after login. Sanitised at the
        // point of entry — this is the only place a user-influenced value
        // reaches the redirect store (the other writer is a hardcoded '/saved').
        sessionStorage.setItem('authRedirect', safeRedirectPath(location.pathname));
        navigate('/login', { replace: true });
      } else {
        // Only redirect truly new users to onboarding (not existing users)
        const onboardingComplete = localStorage.getItem('onboarding_complete');
        if (!onboardingComplete && location.pathname === '/portfolio') {
          // Check account age - only redirect users created after onboarding was deployed
          const createdAt = new Date(user.created_at || 0);
          const onboardingDeployDate = new Date('2026-03-16T00:00:00Z');
          if (createdAt > onboardingDeployDate) {
            navigate('/onboarding/welcome', { replace: true });
          } else {
            // Existing user — mark onboarding as complete automatically
            localStorage.setItem('onboarding_complete', 'true');
          }
        }
      }
      setIsChecking(false);
    }
  }, [user, loading, navigate, location.pathname]);

  if (loading || isChecking) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center">
        <div className="text-center">
          <Loader className="w-8 h-8 text-blue-500 animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
}
