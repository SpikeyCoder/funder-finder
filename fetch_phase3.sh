#!/bin/bash
SUPABASE_URL="https://tgtotjvdubhjxzybmdex.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRndG90anZkdWJoanh6eWJtZGV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNTA5NTQsImV4cCI6MjA4NzYyNjk1NH0.Wehk_mEUN0G7qzvYKlKbajL1tJqgFqu1joR1DG0M8cs"

fetch_chunk() {
  local order=$1
  curl -s "${SUPABASE_URL}/rest/v1/_temp_transfer?chunk_order=eq.${order}&select=data" \
    -H "apikey: ${ANON_KEY}" \
    -H "Authorization: Bearer ${ANON_KEY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['data'] if d else '')"
}

fetch_and_write() {
  local filepath=$1
  shift
  local orders=("$@")
  echo "Fetching ${filepath}..."
  local combined=""
  for order in "${orders[@]}"; do
    local chunk=$(fetch_chunk "$order")
    combined="${combined}${chunk}"
  done
  mkdir -p "$(dirname "$filepath")"
  echo "$combined" | base64 -d > "$filepath"
  echo "  Written $(wc -c < "$filepath") bytes"
}

fetch_and_write "supabase/functions/tracked-grants/index.ts" 1
fetch_and_write "supabase/functions/pipeline-statuses/index.ts" 2
fetch_and_write "supabase/functions/portfolio/index.ts" 3
fetch_and_write "supabase/functions/grant-tasks/index.ts" 4
fetch_and_write "supabase/functions/calendar-feed/index.ts" 5
fetch_and_write "supabase/functions/process-notifications/index.ts" 6
fetch_and_write "src/App.tsx" 7
fetch_and_write "src/components/NavBar.tsx" 8
fetch_and_write "src/types.ts" 9
fetch_and_write "src/pages/MyTasksPage.tsx" 10
fetch_and_write "src/pages/PortfolioPage.tsx" 11
fetch_and_write "PHASE3_DEPLOY.md" 12
fetch_and_write "src/pages/UserSettingsPage.tsx" 130 131 132 133
fetch_and_write "src/pages/ProjectWorkspace.tsx" 140 141 142 143 144 145

echo ""
echo "All Phase 3 files fetched successfully!"
