#!/bin/bash
# Smoke test for API endpoints: GET /api/cards/:id, claim, heartbeat, release

set -e

API_BASE="http://127.0.0.1:8788/api"
SESSION_ID="smoke-test-$(date +%s)"

echo "=== Claw-Kanban API Smoke Test ==="
echo ""

# Check if server is running
echo "1. Health check..."
HEALTH=$(curl -s "$API_BASE/health")
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo "✓ Server is healthy"
else
  echo "✗ Server health check failed: $HEALTH"
  exit 1
fi
echo ""

# Create a test card
echo "2. Creating test card..."
CREATE_RESPONSE=$(curl -s -X POST "$API_BASE/cards" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Smoke test card\",\"description\":\"Testing API endpoints\",\"project_path\":\"/tmp/test-project\"}")
CARD_ID=$(echo "$CREATE_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$CARD_ID" ]; then
  echo "✗ Failed to create card: $CREATE_RESPONSE"
  exit 1
fi
echo "✓ Created card: $CARD_ID"
echo ""

# Test GET /api/cards/:id
echo "3. Testing GET /api/cards/:id..."
CARD_RESPONSE=$(curl -s "$API_BASE/cards/$CARD_ID")
if echo "$CARD_RESPONSE" | grep -q '"card"'; then
  echo "✓ GET /api/cards/:id works"
  echo "   Response: $(echo "$CARD_RESPONSE" | grep -o '"title":"[^"]*"' | head -1)"
else
  echo "✗ GET /api/cards/:id failed: $CARD_RESPONSE"
  exit 1
fi
echo ""

# Test claim endpoint
echo "4. Testing POST /api/cards/:id/claim..."
CLAIM_RESPONSE=$(curl -s -X POST "$API_BASE/cards/$CARD_ID/claim" \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SESSION_ID\"}")

if echo "$CLAIM_RESPONSE" | grep -q '"ok":true'; then
  echo "✓ Claim successful"
  echo "   Session: $SESSION_ID"
else
  echo "✗ Claim failed: $CLAIM_RESPONSE"
  exit 1
fi
echo ""

# Test re-claim (should be idempotent)
echo "5. Testing idempotent re-claim..."
RECLAIM_RESPONSE=$(curl -s -X POST "$API_BASE/cards/$CARD_ID/claim" \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SESSION_ID\"}")

if echo "$RECLAIM_RESPONSE" | grep -q '"ok":true'; then
  echo "✓ Re-claim successful (idempotent)"
else
  echo "✗ Re-claim failed: $RECLAIM_RESPONSE"
  exit 1
fi
echo ""

# Test claim by wrong session (should fail with 409)
echo "6. Testing claim conflict (wrong session)..."
WRONG_SESSION_RESPONSE=$(curl -s -X POST "$API_BASE/cards/$CARD_ID/claim" \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"wrong-session\"}")

if echo "$WRONG_SESSION_RESPONSE" | grep -q '"error":"not_claimable"'; then
  echo "✓ Correctly rejected wrong session claim (409)"
else
  echo "⚠ Expected 409 not_claimable, got: $WRONG_SESSION_RESPONSE"
fi
echo ""

# Test heartbeat
echo "7. Testing POST /api/cards/:id/heartbeat..."
HEARTBEAT_RESPONSE=$(curl -s -X POST "$API_BASE/cards/$CARD_ID/heartbeat" \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SESSION_ID\"}")

if echo "$HEARTBEAT_RESPONSE" | grep -q '"ok":true'; then
  echo "✓ Heartbeat successful"
  EXPIRY=$(echo "$HEARTBEAT_RESPONSE" | grep -o '"claim_expires_at":[0-9]*' | cut -d':' -f2)
  echo "   Lease expires at: $EXPIRY"
else
  echo "✗ Heartbeat failed: $HEARTBEAT_RESPONSE"
  exit 1
fi
echo ""

# Test heartbeat with wrong session (should fail with 409)
echo "8. Testing heartbeat conflict (wrong session)..."
WRONG_HB_RESPONSE=$(curl -s -X POST "$API_BASE/cards/$CARD_ID/heartbeat" \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"wrong-session\"}")

if echo "$WRONG_HB_RESPONSE" | grep -q '"error":"not_claimed_by_you"'; then
  echo "✓ Correctly rejected wrong session heartbeat (409)"
else
  echo "⚠ Expected 409 not_claimed_by_you, got: $WRONG_HB_RESPONSE"
fi
echo ""

# Test release
echo "9. Testing POST /api/cards/:id/release..."
RELEASE_RESPONSE=$(curl -s -X POST "$API_BASE/cards/$CARD_ID/release" \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SESSION_ID\",\"outcome\":\"done\"}")

if echo "$RELEASE_RESPONSE" | grep -q '"ok":true'; then
  echo "✓ Release successful (outcome: done)"
  NEW_STATUS=$(echo "$RELEASE_RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "   New status: $NEW_STATUS"
  if [ "$NEW_STATUS" = "Review/Test" ]; then
    echo "✓ Status correctly set to Review/Test"
  else
    echo "⚠ Expected status Review/Test, got: $NEW_STATUS"
  fi
else
  echo "✗ Release failed: $RELEASE_RESPONSE"
  exit 1
fi
echo ""

# Test release on unclaimed card (should fail with 409)
echo "10. Testing release conflict (not claimed)..."
UNCLAIMED_RELEASE=$(curl -s -X POST "$API_BASE/cards/$CARD_ID/release" \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SESSION_ID\",\"outcome\":\"abandon\"}")

if echo "$UNCLAIMED_RELEASE" | grep -q '"error":"not_claimed_by_you"'; then
  echo "✓ Correctly rejected release on unclaimed card (409)"
else
  echo "⚠ Expected 409 not_claimed_by_you, got: $UNCLAIMED_RELEASE"
fi
echo ""

# Cleanup: delete test card
echo "11. Cleaning up..."
DELETE_RESPONSE=$(curl -s -X DELETE "$API_BASE/cards/$CARD_ID")
if echo "$DELETE_RESPONSE" | grep -q '"ok":true'; then
  echo "✓ Test card deleted"
else
  echo "⚠ Failed to delete test card: $DELETE_RESPONSE"
fi
echo ""

echo "=== All smoke tests passed! ==="
