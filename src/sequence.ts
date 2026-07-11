/**
 * Minimal Mermaid `sequenceDiagram` parser producing frozen value objects.
 *
 * Sequence diagrams complement a TOML spec's rules and cases: rules say *what*
 * must be true, diagrams say *who talks to whom, in what order*. For React the
 * actors are the concrete collaborators of an interaction contract — the user,
 * the component, and its callbacks / store / router — so a diagram pins down an
 * ordered multi-actor protocol (`user -> SearchBox -> onSearch`) the way a rule
 * cannot. Each message gets a stable id (`M1`, `M2`, ...) so test cases can
 * claim coverage of it and the builder can verify — mechanically — that no
 * interaction was dropped.
 *
 * Covers the common subset: participants/actors (with aliases), call arrows
 * (`->>`, `->`), reply arrows (`-->>`, `-->`), async arrows (`-)`, `--)`),
 * `+`/`-` activation markers, and `alt`/`else`/`opt`/`loop`/`par`/`critical`
 * blocks (recorded as context on each message). Notes and styling directives
 * are ignored.
 *
 * A straight port of `pyllm.bdd.sequence`; this module is shared verbatim in
 * spirit across the Python and React front-ends.
 */

export type MessageKind = "call" | "reply" | "async";

export interface SequenceMessage {
  readonly id: string;
  readonly sender: string;
  readonly receiver: string;
  readonly text: string;
  readonly kind: MessageKind;
  /** enclosing alt/opt/loop labels */
  readonly context: readonly string[];
}

export interface SequenceDiagram {
  readonly participants: readonly string[];
  readonly messages: readonly SequenceMessage[];
  /** normalized mermaid source, for verbatim re-emission */
  readonly source: string;
}

const ARROW =
  /^(?<sender>[^-<>:]+?)\s*(?<arrow>-->>|->>|--\)|-\)|-->|->)\s*(?<activation>[+-]?)\s*(?<receiver>[^:]+?)\s*:\s*(?<text>.*)$/;

const KINDS: Record<string, MessageKind> = {
  "->>": "call",
  "->": "call",
  "-->>": "reply",
  "-->": "reply",
  "-)": "async",
  "--)": "async",
};

const BLOCK_OPENERS = new Set([
  "alt",
  "opt",
  "loop",
  "par",
  "critical",
  "rect",
  "break",
]);

/** One line per message with its id — the planner prompt format. */
export function toAnnotated(diagram: SequenceDiagram): string {
  return diagram.messages
    .map((m) => {
      const where = m.context.length ? ` [${m.context.join(" / ")}]` : "";
      return `${m.id}: ${m.sender} -[${m.kind}]-> ${m.receiver}: ${m.text}${where}`;
    })
    .join("\n");
}

/**
 * Parse a mermaid `sequenceDiagram` block.
 *
 * `start` sets the first message number, so multiple diagrams attached to one
 * feature keep globally unique ids.
 */
export function parse(text: string, options: { start?: number } = {}): SequenceDiagram {
  const start = options.start ?? 1;
  const participants: string[] = [];
  const messages: SequenceMessage[] = [];
  const context: string[] = [];
  const sourceLines: string[] = [];
  let seenHeader = false;
  let n = start;

  const noteParticipant = (name: string): void => {
    if (!participants.includes(name)) participants.push(name);
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    sourceLines.push(line);
    if (line === "sequenceDiagram") {
      seenHeader = true;
      continue;
    }
    const spaceAt = line.indexOf(" ");
    const word = spaceAt === -1 ? line : line.slice(0, spaceAt);
    const rest = spaceAt === -1 ? "" : line.slice(spaceAt + 1);
    if (word === "participant" || word === "actor") {
      // "participant A as Alias" declares A; messages use the bare name.
      noteParticipant(rest.split(" as ")[0]!.trim());
      continue;
    }
    if (BLOCK_OPENERS.has(word)) {
      context.push(`${word} ${rest.trim()}`.trim());
      continue;
    }
    if (word === "else") {
      if (context.length) context[context.length - 1] = `else ${rest.trim()}`.trim();
      continue;
    }
    if (word === "end") {
      if (context.length) context.pop();
      continue;
    }
    const match = ARROW.exec(line);
    if (match === null || !match.groups) continue; // notes, activate/deactivate, styling
    const sender = match.groups["sender"]!.trim();
    const receiver = match.groups["receiver"]!.trim();
    noteParticipant(sender);
    noteParticipant(receiver);
    messages.push({
      id: `M${n}`,
      sender,
      receiver,
      text: match.groups["text"]!.trim(),
      kind: KINDS[match.groups["arrow"]!]!,
      context: Object.freeze([...context]),
    });
    n += 1;
  }

  if (!seenHeader) {
    throw new Error("no 'sequenceDiagram' header found in mermaid source");
  }
  return {
    participants: Object.freeze([...participants]),
    messages: Object.freeze(messages),
    source: sourceLines.join("\n"),
  };
}
