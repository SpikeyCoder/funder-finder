#!/bin/bash
# Batch-populate NTEE codes from ProPublica
# Each call processes ~200 recipients (most active first)
# Run this script to process all 108K+ recipients in shards

# Configuration via environment variables — see README for setup.
# SUPABASE_URL  : project URL for the update-ntee-codes function
# SUPABASE_ANON_KEY : the publishable/anon key (RLS-protected, safe to be public,
#                     but keeping it out of source so rotation is a one-line env change).
SUPABASE_URL="${SUPABASE_FUNCTION_URL:-https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/update-ntee-codes}"
ANON_KEY="${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY in your shell or .env.local before running this script}"

BATCH_SIZE=200
TOTAL_BATCHES=550  # ~108K / 200 = 540 batches, plus buffer
DELAY=2            # seconds between batches (respect ProPublica rate limits)

echo "=== NTEE Code Batch Updater ==="
echo "Processing up to $TOTAL_BATCHES batches of $BATCH_SIZE recipients each"
echo ""

for i in $(seq 1 $TOTAL_BATCHES); do
  echo -n "Batch $i/$TOTAL_BATCHES: "

  RESPONSE=$(curl -s -X POST "$SUPABASE_URL" \
    -H "Authorization: Bearer $ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"batch_size\": $BATCH_SIZE}")

  # Parse response
  PROCESSED=$(echo "$RESPONSE" | grep -o '"processed":[0-9]*' | cut -d: -f2)
  UPDATED=$(echo "$RESPONSE" | grep -o '"updated":[0-9]*' | cut -d: -f2)
  REMAINING=$(echo "$RESPONSE" | grep -o '"remaining":[0-9]*' | cut -d: -f2)
  ERRORS=$(echo "$RESPONSE" | grep -o '"errors":[0-9]*' | cut -d: -f2)

  echo "processed=$PROCESSED updated=$UPDATED remaining=$REMAINING errors=$ERRORS"

  # Stop if nothing left to process
  if [ "$PROCESSED" = "0" ] || [ "$REMAINING" = "0" ]; then
    echo ""
    echo "=== Done! All recipients have been processed. ==="
    break
  fi

  # Brief pause between batches
  sleep $DELAY
done

echo ""
echo "Batch processing complete."
