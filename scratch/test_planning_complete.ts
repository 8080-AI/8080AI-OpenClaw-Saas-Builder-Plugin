/**
 * Simulates the /projects/:id/events SSE stream ending with planning_complete
 * and verifies that streamProjectEvents calls onPlanningComplete correctly.
 *
 * Run with: npx tsx scratch/test_planning_complete.ts
 */
import { createServer } from "http";
import { createApiClient } from "../src/api-client.ts";

const PROJECT_ID = "test-project-123";

const SSE_EVENTS = [
  JSON.stringify({ type: "srd_stream_chunk", project_id: PROJECT_ID, content: " a", seq: 1, done: false }),
  JSON.stringify({ type: "srd_stream_chunk", project_id: PROJECT_ID, content: " clean", seq: 2, done: false }),
  JSON.stringify({
    type: "ai_overview_text",
    id: "abc123",
    project_id: PROJECT_ID,
    agent_type: "Tech Lead",
    content: "Exciting update: the Architect has started outlining the API flow.",
    run_group: "run-group-1",
    created_at: new Date().toISOString(),
  }),
  JSON.stringify({
    type: "planning_complete",
    project_id: PROJECT_ID,
    status: "paused_for_review",
    triggered_by: "7d86b914-73ba-473a-bd97-678c8f926d2a",
  }),
];

const server = createServer((req, res) => {
  if (req.url === `/api/v1/projects/${PROJECT_ID}/events`) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let i = 0;
    const send = () => {
      if (i >= SSE_EVENTS.length) {
        res.end();
        return;
      }
      res.write(`data: ${SSE_EVENTS[i]}\n\n`);
      i++;
      setTimeout(send, 50);
    };
    send();
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(9999, async () => {
  console.log("Mock SSE server running on http://localhost:9999\n");

  const client = createApiClient({
    token: "test-token",
    apiBaseUrl: "http://localhost:9999/api/v1",
  });

  let srdContent = "";
  let aiOverview = "";
  let planningCompleteData: any = null;

  await client.streamProjectEvents(PROJECT_ID, {
    onSrdChunk: (chunk) => {
      srdContent += chunk.content;
      console.log(`[srd_stream_chunk] seq=${chunk.seq} content="${chunk.content}"`);
    },
    onAiOverview: (msg) => {
      aiOverview = msg.content;
      console.log(`[ai_overview_text] agent=${msg.agent_type} content="${msg.content.slice(0, 50)}..."`);
    },
    onPlanningComplete: (data) => {
      planningCompleteData = data;
      console.log(`[planning_complete] status="${data.status}"`);
    },
  });

  console.log("\n--- Results ---");
  console.log("SRD content:", JSON.stringify(srdContent));
  console.log("AI overview:", JSON.stringify(aiOverview.slice(0, 60)));
  console.log("Planning complete:", planningCompleteData);

  if (planningCompleteData?.status === "paused_for_review") {
    console.log("\n✅ PASS: paused_for_review detected correctly");
    console.log("   → Would show buttons: 1. ▶️ Continue  2. 🔍 Review");
  } else {
    console.log("\n❌ FAIL: paused_for_review not detected");
  }

  server.close();
});
