import { estimateMessagesTokens } from "@amb/context";
import type { NewEvent } from "@amb/protocol";
import { profileFor, resolveRequestedModel } from "@amb/reliability";
import {
  type CapabilityPort,
  type ChatClient,
  type Msg,
  type WorkspaceContextPort,
  compactConversation,
} from "@amb/runtime";

export type CompactNowResult =
  | { ok: true; messages: Msg[]; before: number; after: number; model: string }
  | { ok: false; reason: string };

/** How much recent conversation `/compact` keeps word for word (a share of the model's window). */
const KEEP_RECENT_SHARE = 0.05;

/**
 * `/compact [focus]`: summarize the carried conversation now, sized to the model that will read it, keeping
 * only the most recent exchange verbatim. The same summarizer automatic compaction uses — so the summary
 * compounds into project memory the same way.
 */
export async function compactNow(opts: {
  client: ChatClient;
  conversation: readonly Msg[];
  /** The model the next message will go to (the one last served, or the requested one). */
  model: string;
  workspace: WorkspaceContextPort;
  workspaceRoot: string;
  sessionId: string;
  focus?: string;
  signal: AbortSignal;
  emit: (ev: NewEvent) => void;
  capabilities?: CapabilityPort;
}): Promise<CompactNowResult> {
  if (opts.conversation.length < 3) return { ok: false, reason: "nothing to compact yet" };
  let catalog: Awaited<ReturnType<ChatClient["fetchCatalog"]>>;
  try {
    catalog = await opts.client.fetchCatalog(opts.signal);
  } catch {
    return { ok: false, reason: "couldn't reach Ambient to summarize — try again in a moment" };
  }
  const target = resolveRequestedModel(opts.model, catalog)?.target ?? opts.model;
  const profile = profileFor(
    target,
    catalog.find((m) => m.id === target),
    { ceiling: opts.capabilities?.learnedCeiling?.(target) },
  );
  // The anchor slot is empty here: the next run puts its own system prompt in front of the conversation.
  const messages: Msg[] = [{ role: "system", content: "" }, ...opts.conversation];
  const before = estimateMessagesTokens(messages);
  const next = await compactConversation(
    opts.client,
    messages,
    target,
    catalog,
    opts.sessionId,
    "trn_compact",
    opts.emit,
    opts.signal,
    (summary) => opts.workspace.writeMemory(opts.workspaceRoot, summary),
    profile.window,
    opts.workspace.readMemory(opts.workspaceRoot) ?? "",
    {
      keepRecentTokens: Math.floor(profile.window * KEEP_RECENT_SHARE),
      ...(opts.focus?.trim() ? { focus: opts.focus.trim() } : {}),
    },
  );
  if (!next) return { ok: false, reason: "the conversation is already as small as it gets" };
  return {
    ok: true,
    messages: next.slice(1),
    before,
    after: estimateMessagesTokens(next),
    model: target,
  };
}
