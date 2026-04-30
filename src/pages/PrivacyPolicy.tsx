import NavBar from '../components/NavBar';
import Footer from '../components/Footer';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />

      <main id="main-content" className="px-6 pt-24 pb-20 max-w-3xl mx-auto">
        <h1 className="text-4xl font-bold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-400 mb-10">Last updated: April 7, 2026</p>

        <div className="space-y-8 text-gray-300 leading-relaxed text-[15px]">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">Overview</h2>
            <p>
              FunderMatch (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) respects
              your privacy. This policy explains what information we collect when you use
              fundermatch.org, how we use it, and the choices you have.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">Information We Collect</h2>
            <p className="mb-3">
              <strong className="text-white">Information you provide.</strong> When you use
              FunderMatch, you may enter a mission statement, the location your nonprofit serves,
              and organizational details. If you create an account, we also store your email
              address and a securely hashed password.
            </p>
            <p>
              <strong className="text-white">Information collected automatically.</strong> We
              collect basic usage data such as pages visited, browser type, and approximate
              location (country/region) through privacy-respecting analytics. We do not use
              third-party advertising trackers.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">How We Use Your Information</h2>
            <p>We use the information we collect to:</p>
            <ul className="list-disc list-inside mt-2 space-y-1 text-gray-400">
              <li>Match your nonprofit with relevant funders, foundations, and giving programs</li>
              <li>Generate AI-assisted grant application drafts personalized to your mission</li>
              <li>Save your funder pipeline and application statuses across sessions</li>
              <li>Improve the accuracy and relevance of our matching algorithms</li>
              <li>Maintain and improve the reliability of our service</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">Data Storage &amp; Security</h2>
            <p>
              Your data is stored securely using Supabase, which provides encryption at rest
              and in transit. We follow industry-standard security practices including HTTPS
              everywhere, parameterized database queries, and row-level security policies.
              We do not sell, rent, or share your personal data with third parties for marketing
              purposes.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">Cookies &amp; Local Storage</h2>
            <p>
              We use essential cookies and local storage to keep you signed in and remember
              your preferences. We do not use cookies for advertising or cross-site tracking.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">Your Rights</h2>
            <p>You have the right to:</p>
            <ul className="list-disc list-inside mt-2 space-y-1 text-gray-400">
              <li>Access the personal data we hold about you</li>
              <li>Request correction of inaccurate data</li>
              <li>Request deletion of your account and associated data</li>
              <li>Export your saved funders and pipeline data</li>
              <li>Withdraw consent for data processing at any time</li>
            </ul>
            <p className="mt-3">
              To exercise any of these rights, contact us at{' '}
              <a href="mailto:kevinmarmstrong1990@gmail.com" className="text-blue-400 hover:text-blue-300 underline">
                kevinmarmstrong1990@gmail.com
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">Third-Party Services</h2>
            <p>
              We use the following third-party services to operate FunderMatch:
            </p>
            <ul className="list-disc list-inside mt-2 space-y-1 text-gray-400">
              <li>Supabase — database, authentication, and storage</li>
              <li>Vercel — hosting and content delivery</li>
              <li>OpenAI / Anthropic — AI-powered funder matching and grant writing</li>
            </ul>
            <p className="mt-3">
              Each provider processes data in accordance with their own privacy policies.
              We only share the minimum data necessary for each service to function.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">Children&rsquo;s Privacy</h2>
            <p>
              FunderMatch is not directed at individuals under 13 years of age. We do not
              knowingly collect personal information from children.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">Changes to This Policy</h2>
            <p>
              We may update this privacy policy from time to time. When we make changes, we
              will update the &ldquo;Last updated&rdquo; date at the top of this page. We
              encourage you to review this policy periodically.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">Contact Us</h2>
            <p>
              If you have questions about this privacy policy or how we handle your data,
              please reach out at{' '}
              <a href="mailto:kevinmarmstrong1990@gmail.com" className="text-blue-400 hover:text-blue-300 underline">
                kevinmarmstrong1990@gmail.com
              </a>.
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
