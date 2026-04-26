import NavBar from '../components/NavBar';
import Footer from '../components/Footer';

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />

      <div className="px-6 pt-24 pb-20 max-w-3xl mx-auto">
        <h1 className="text-4xl font-bold tracking-tight mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-400 mb-10">Last updated: April 26, 2026</p>

        <div className="space-y-8 text-gray-300 leading-relaxed text-[15px]">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Acceptance of Terms</h2>
            <p>
              By accessing or using FunderMatch at fundermatch.org (&ldquo;the Service&rdquo;), you agree
              to be bound by these Terms of Service (&ldquo;Terms&rdquo;). If you do not agree to these
              Terms, please do not use the Service. These Terms constitute a legally binding agreement
              between you and FunderMatch (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. Description of Service</h2>
            <p>
              FunderMatch is a web application that helps nonprofit organizations discover potential
              funders and foundations. Our matching algorithms analyze publicly available IRS Form 990
              filings to surface funders whose historical giving patterns align with your nonprofit&rsquo;s
              mission, geography, and program focus. The Service also provides AI-assisted grant writing
              tools and a pipeline management workspace.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. User Accounts</h2>
            <p className="mb-3">
              You may use certain features of the Service without creating an account. To access
              saved funders, project workspaces, and other personalized features, you must register
              for a free account.
            </p>
            <p className="mb-3">
              You are responsible for maintaining the confidentiality of your account credentials
              and for all activity that occurs under your account. You agree to notify us immediately
              of any unauthorized use of your account.
            </p>
            <p>
              You must provide accurate and complete information when creating an account. We reserve
              the right to suspend or terminate accounts that contain false information or that
              violate these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Acceptable Use</h2>
            <p className="mb-3">You agree to use the Service only for lawful purposes. You must not:</p>
            <ul className="list-disc list-inside mt-2 space-y-1 text-gray-400">
              <li>Scrape, crawl, or otherwise harvest data from the Service using automated means</li>
              <li>Misuse, redistribute, or resell funder data obtained through the Service</li>
              <li>Attempt to reverse-engineer or extract our underlying matching algorithms or databases</li>
              <li>Use the Service to harass, spam, or send unsolicited communications to funders</li>
              <li>Interfere with or disrupt the integrity or performance of the Service</li>
              <li>Use the Service for any purpose that violates applicable law or regulation</li>
              <li>Impersonate any person or entity, or misrepresent your affiliation with a nonprofit</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Data Accuracy Disclaimer</h2>
            <p className="mb-3">
              Funder data displayed in FunderMatch is sourced from publicly available IRS Form 990
              filings and other public records. This data may not reflect the current giving priorities,
              contact information, or operational status of any foundation or funder.
            </p>
            <p>
              We make no warranties regarding the accuracy, completeness, or timeliness of funder
              information. You should independently verify funder details and eligibility requirements
              before submitting any grant application. FunderMatch is a discovery and research tool,
              not an authoritative directory.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. Intellectual Property</h2>
            <p className="mb-3">
              The Service, including its design, features, code, and original content, is owned by
              FunderMatch and protected by applicable intellectual property laws. You may not copy,
              modify, distribute, or create derivative works based on the Service without our
              express written consent.
            </p>
            <p>
              By submitting content to the Service (such as mission statements or project descriptions),
              you grant us a limited, non-exclusive license to use that content solely for the purpose
              of providing and improving the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. Limitation of Liability</h2>
            <p className="mb-3">
              The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo; without warranties of
              any kind, either express or implied, including but not limited to warranties of
              merchantability, fitness for a particular purpose, or non-infringement.
            </p>
            <p className="mb-3">
              To the fullest extent permitted by law, FunderMatch shall not be liable for any
              indirect, incidental, special, consequential, or punitive damages arising from your
              use of or inability to use the Service, even if we have been advised of the possibility
              of such damages.
            </p>
            <p>
              Our total liability to you for any claims arising from these Terms or your use of the
              Service shall not exceed the amount you paid us in the twelve months preceding the claim
              (or $100 if you have not paid us anything).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">8. Changes to Terms</h2>
            <p>
              We may update these Terms from time to time. When we make material changes, we will
              update the &ldquo;Last updated&rdquo; date at the top of this page. Your continued use of
              the Service after any changes constitutes acceptance of the updated Terms. We encourage
              you to review these Terms periodically.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">9. Governing Law</h2>
            <p>
              These Terms are governed by and construed in accordance with the laws of the State of
              Washington, without regard to its conflict of law provisions. Any disputes arising
              under these Terms shall be subject to the exclusive jurisdiction of the state and
              federal courts located in Washington State.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">10. Contact</h2>
            <p>
              If you have questions about these Terms, please contact us at{' '}
              <a href="mailto:kevinmarmstrong1990@gmail.com" className="text-blue-400 hover:text-blue-300 underline">
                kevinmarmstrong1990@gmail.com
              </a>.
            </p>
          </section>
        </div>
      </div>

      <Footer />
    </div>
  );
}
