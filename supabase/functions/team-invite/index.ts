// Phase 4A: Team invitation management
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const authHeader = req.headers.get('authorization') || '';
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const jwt = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  try {
    if (req.method === 'GET') {
      // List team members and pending invitations
      const { data: members } = await supabase
        .from('org_members')
        .select('*')
        .or(`user_id.eq.${user.id},invited_by.eq.${user.id}`)
        .eq('status', 'active');

      const { data: invitations } = await supabase
        .from('invitations')
        .select('*')
        .eq('invited_by', user.id)
        .eq('status', 'pending');

      // Get emails for members
      const memberDetails = [];
      for (const m of members || []) {
        const { data: ud } = await supabase.auth.admin.getUserById(m.user_id);
        memberDetails.push({ ...m, email: ud?.user?.email || 'unknown' });
      }

      return json({ members: memberDetails, invitations });
    }

    if (req.method === 'POST') {
      const { email, role = 'editor' } = await req.json();
      if (!email) return json({ error: 'Email is required' }, 400);

      // Check if already invited
      const { data: existing } = await supabase
        .from('invitations')
        .select('id')
        .eq('email', email.toLowerCase())
        .eq('invited_by', user.id)
        .eq('status', 'pending')
        .limit(1);

      if (existing && existing.length > 0) return json({ error: 'Already invited' }, 409);

      // Create invitation
      const { data: invite, error } = await supabase
        .from('invitations')
        .insert({ email: email.toLowerCase(), role, invited_by: user.id })
        .select()
        .single();

      if (error) throw error;

      // If user already exists, auto-add to org_members
      const { data: existingUsers } = await supabase.auth.admin.listUsers();
      const existingUser = existingUsers?.users?.find(u => u.email === email.toLowerCase());

      if (existingUser) {
        await supabase.from('org_members').upsert({
          user_id: existingUser.id,
          role,
          invited_by: user.id,
          status: 'active',
        }, { onConflict: 'user_id' });

        await supabase.from('invitations').update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq('id', invite.id);
      }

      return json(invite, 201);
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url);
      const inviteId = url.searchParams.get('id');
      if (!inviteId) return json({ error: 'id required' }, 400);

      await supabase.from('invitations').update({ status: 'revoked' }).eq('id', inviteId).eq('invited_by', user.id);
      return json({ success: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
});
