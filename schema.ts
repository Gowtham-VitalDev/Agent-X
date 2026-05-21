import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Agentify — Convex Data Schema
 *
 * Core design principles:
 * - Agents are versioned: publishing creates a snapshot, edits don't break live embeds
 * - Node graphs are stored as serializable JSON, not generated code
 * - Token usage is tracked per conversation turn for metering/billing
 * - All user-facing IDs are Convex IDs (not sequential ints) — no enumeration attacks
 */

export default defineSchema({
  // ─── Users ──────────────────────────────────────────────────────────────────
  users: defineTable({
    clerkId: v.string(),           // Clerk userId — used to resolve identity from JWT
    email: v.string(),
    name: v.string(),
    plan: v.union(                 // Plan tier — read from Convex, not JWT, for security
      v.literal("free"),
      v.literal("pro"),
      v.literal("team")
    ),
    dailyRequestCount: v.number(), // Rolling counter for rate limiting (reset nightly via cron)
    createdAt: v.number(),
  })
    .index("by_clerk_id", ["clerkId"])
    .index("by_email", ["email"]),

  // ─── Agents ─────────────────────────────────────────────────────────────────
  agents: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),

    // LLM configuration
    provider: v.union(
      v.literal("openai"),
      v.literal("google"),
      v.literal("anthropic")
    ),
    model: v.string(),             // e.g. "gpt-4o", "gemini-1.5-flash", "claude-3-5-sonnet"
    systemPrompt: v.string(),      // Base system instructions for the agent
    temperature: v.number(),       // 0–2, stored per agent
    maxTokens: v.number(),         // Hard cap per response
    contextWindowTurns: v.number(),// How many history turns to retain (sliding window)

    // Graph — stored as data, interpreted at runtime (see KEY DECISION #1 in README)
    nodes: v.array(v.object({
      id: v.string(),
      type: v.union(
        v.literal("input"),        // Entry point — receives user message
        v.literal("prompt"),       // Injects a static prompt segment
        v.literal("condition"),    // Branches based on LLM output
        v.literal("tool"),         // Calls an external tool/API
        v.literal("output")        // Final response node
      ),
      data: v.any(),               // Node-type-specific config (validated at mutation layer)
      position: v.object({ x: v.number(), y: v.number() }),
    })),
    edges: v.array(v.object({
      id: v.string(),
      source: v.string(),
      target: v.string(),
      label: v.optional(v.string()),
    })),

    // Publishing
    isPublished: v.boolean(),
    publishedAt: v.optional(v.number()),
    publicApiKey: v.optional(v.string()), // Scoped key for embedded widget — agentId-only, no user creds
    embedSnippet: v.optional(v.string()), // Generated <script> tag

    // Metadata
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_api_key", ["publicApiKey"]),

  // ─── Conversations ───────────────────────────────────────────────────────────
  conversations: defineTable({
    agentId: v.id("agents"),
    userId: v.optional(v.id("users")), // null for anonymous embedded widget sessions
    sessionId: v.string(),             // Client-generated UUID for anonymous sessions

    status: v.union(
      v.literal("active"),
      v.literal("ended")
    ),

    // Aggregated token usage for this conversation (for billing/metering)
    totalInputTokens: v.number(),
    totalOutputTokens: v.number(),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_agent", ["agentId"])
    .index("by_session", ["sessionId"])
    .index("by_user", ["userId"]),

  // ─── Messages ────────────────────────────────────────────────────────────────
  messages: defineTable({
    conversationId: v.id("conversations"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system")        // Injected prompt segments from nodes
    ),
    content: v.string(),

    // Token accounting per turn
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    model: v.optional(v.string()),     // Which model generated this response

    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"]),

  // ─── Usage Events ────────────────────────────────────────────────────────────
  // Append-only log — supports billing, abuse detection, analytics
  usageEvents: defineTable({
    userId: v.optional(v.id("users")),
    agentId: v.id("agents"),
    conversationId: v.id("conversations"),
    eventType: v.union(
      v.literal("chat_request"),
      v.literal("rate_limited"),
      v.literal("blocked_by_arcjet"),
      v.literal("agent_published"),
      v.literal("embed_loaded")
    ),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_user_date", ["userId", "createdAt"])
    .index("by_agent", ["agentId"]),
});
