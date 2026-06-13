/**
 * API client for the onboarding-advisor edge function.
 *
 * The edge function (deployed in PR #178) provides conversational grant
 * strategy guidance during onboarding. It requires a valid JWT
 * (verify_jwt = true).
 */

import { getEdgeFunctionHeaders } from './supabase';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const ADVISOR_URL = `${SUPABASE_URL}/functions/v1/onboarding-advisor`;

export interface AdvisorMessage {
  role: 'assistant' | 'user';
  content: string;
}

export interface OrgProfile {
  organization_name?: string;
  mission_statement?: string;
  city?: string;
  state?: string;
  county?: string;
  org_type?: string;
  fields_of_work?: string[];
}

export interface AdvisorTip {
  text: string;
  category?: string;
}

export interface AdvisorResponse {
  reply: string;
  chips: string[];
  profile_updates: Partial<OrgProfile>;
  tips: AdvisorTip[];
  confidence: number;
  next_step: 0 | 1 | 2 | 3;
  ready_to_proceed: boolean;
}

export async function callOnboardingAdvisor(
  messages: AdvisorMessage[],
  profile: Partial<OrgProfile>,
  step: 0 | 1 | 2 | 3,
): Promise<AdvisorResponse> {
  const headers = await getEdgeFunctionHeaders();
  const res = await fetch(ADVISOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ messages, profile, step }),
  });

  if (!res.ok) {
    let msg = `Advisor returned ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(msg);
  }

  return res.json();
}
