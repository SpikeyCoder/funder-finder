import { useState } from 'react';
import NavBar from '../components/NavBar';
import Footer from '../components/Footer';

export default function ContactPage() {
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', message: '' });

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError('');

    try {
      const res = await fetch(
        'https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/contact-form',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name,
            email: form.email,
            message: form.message,
          }),
        }
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to send message');
      }

      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />

      <main id="main-content" className="px-6 pt-24 pb-20 max-w-2xl mx-auto">
        <h1 className="text-4xl font-bold tracking-tight mb-2">Contact Us</h1>
        <p className="text-gray-400 mb-10">
          Have a question, feedback, or need help? Send us a message and we'll get back to you.
          We typically respond within 1–2 business days.
        </p>

        {submitted ? (
          <div className="rounded-lg border border-green-700 bg-green-900/30 px-6 py-8 text-center">
            <p className="text-xl font-semibold text-green-300 mb-2">Message sent!</p>
            <p className="text-gray-400 text-sm">
              Thanks for reaching out. We'll reply to{' '}
              <span className="text-white">{form.email}</span> within 1–2 business days.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-300 mb-1">
                Name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                value={form.name}
                onChange={handleChange}
                className="w-full rounded-md border border-[#1b2130] bg-[#161b27] px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Your name"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                value={form.email}
                onChange={handleChange}
                className="w-full rounded-md border border-[#1b2130] bg-[#161b27] px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="message" className="block text-sm font-medium text-gray-300 mb-1">
                Message
              </label>
              <textarea
                id="message"
                name="message"
                rows={6}
                required
                value={form.message}
                onChange={handleChange}
                className="w-full rounded-md border border-[#1b2130] bg-[#161b27] px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                placeholder="How can we help?"
              />
            </div>

            {error && (
              <div className="rounded-md border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={sending}
              className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-[#0d1117] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending...' : 'Send message'}
            </button>
          </form>
        )}

        <p className="mt-8 text-sm text-gray-500">
          You can also email us directly at{' '}
          <a href="mailto:support@fundermatch.org" className="text-blue-400 hover:text-blue-300 underline">
            support@fundermatch.org
          </a>.
        </p>
      </main>

      <Footer />
    </div>
  );
}
