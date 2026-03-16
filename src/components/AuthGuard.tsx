import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

interface AuthGuardProps {
  children: React.ReactNode;
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
        // Save the current location for redirect after login
        sessionStorage.setItem('authRedirect', location.pathname);
        navigate('/login', { replace: true });
      } else {
        // Only redirect truly new users to onboarding (not existing users)
        const onboardingComplete = localStorage.getItem('onboarding_complete');
        if (!onboardingComplete && location.pathname === '/dashboard') {
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
