import type { NetworkMessage, NodeId, Rpc } from '../engine';
import { useReducedMotion, useVisualTime } from '../sim/hooks';
import { isCut, lerp, messagePath, type Point, type StageLayout } from '../sim/layout';
import type { Effect } from '../sim/simulation';

interface Props {
  layout: StageLayout;
  sideB: readonly NodeId[];
  inFlight: readonly NetworkMessage[];
  effects: readonly Effect[];
}

/** Where along its path a message on a cut link fades out: the cut mark. */
const CUT_AT = 0.5;

/**
 * Every RPC currently on the wire (getState().inFlight), drawn at its true
 * progress between sentAt and deliverAt. Re-renders every animation frame
 * while playing. Also draws the short-lived effects the engine reported:
 * vote answers (vote_granted / vote_denied) and lost messages (message_dropped).
 */
export function MessageLayer({ layout, sideB, inFlight, effects }: Props) {
  const visualTime = useVisualTime();
  const reduced = useReducedMotion();
  // With reduced motion, messages jump once per tick instead of gliding.
  const t = reduced ? Math.floor(visualTime) : visualTime;
  const path = (from: NodeId, to: NodeId) => messagePath(layout.centers[from - 1], layout.centers[to - 1]);

  return (
    <svg className="layer layer--messages" width={layout.width} height={layout.height} aria-hidden>
      {inFlight.map((m) => {
        const { from, to } = path(m.from, m.to);
        let p = Math.min(1, Math.max(0, (t - m.sentAt) / (m.deliverAt - m.sentAt)));
        let opacity = 1;
        // Crossing the partition: the message won't be delivered (the engine
        // drops it on arrival), so draw it dying at the cut.
        if (isCut(sideB, m.from, m.to)) {
          if (p > CUT_AT - 0.18) opacity = Math.max(0.1, 1 - (p - (CUT_AT - 0.18)) / 0.18);
          p = Math.min(p, CUT_AT);
        }
        const pos = lerp(from, to, p);
        return (
          <g key={m.id} style={{ opacity }}>
            <MessageDot rpc={m.rpc} at={pos} />
          </g>
        );
      })}

      {effects.map((fx) => {
        if (fx.kind === 'vote') {
          // A ✓ or ✗ near the voter, on the line toward the candidate.
          const { from, to } = path(fx.voter, fx.candidate);
          const at = lerp(from, to, 0.18);
          return (
            <g key={fx.id} transform={`translate(${at.x} ${at.y})`}>
              <g className={`fx fx-vote ${fx.granted ? 'is-yes' : 'is-no'}`}>
                <circle r="10" />
                <path d={fx.granted ? 'M-4.5 0.5 L-1.5 3.5 L4.5 -3' : 'M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5'} />
              </g>
            </g>
          );
        }
        if (fx.kind === 'drop') {
          // Partitioned messages die at the cut; messages to a dead node die at its door.
          const { from, to } = path(fx.message.from, fx.message.to);
          const at = lerp(from, to, fx.reason === 'partitioned' ? CUT_AT : 1);
          return (
            <g key={fx.id} transform={`translate(${at.x} ${at.y})`}>
              <g className="fx fx-drop">
                <circle r="9" />
                <path d="M-4 -4 L4 4 M4 -4 L-4 4" />
              </g>
            </g>
          );
        }
        return null;
      })}
    </svg>
  );
}

/**
 * Every message is a circle. Fill says what it is: violet = RequestVote,
 * amber = AppendEntries (bigger, with a count, when it carries entries),
 * green / red = a yes / no reply. A reply's ring keeps its family: violet
 * for a vote reply, amber for an append reply.
 */
function MessageDot({ rpc, at }: { rpc: Rpc; at: Point }) {
  const tr = `translate(${at.x} ${at.y})`;
  switch (rpc.type) {
    case 'RequestVote':
      return <circle className="msg msg--rv" transform={tr} r={6} />;
    case 'AppendEntries':
      return rpc.entries.length === 0 ? (
        <circle className="msg msg--ae" transform={tr} r={6} />
      ) : (
        <g transform={tr}>
          <circle className="msg msg--ae" r={8.5} />
          <text className="msg__count" dy="0.35em">
            {rpc.entries.length}
          </text>
        </g>
      );
    case 'RequestVoteReply':
      return <circle className={`msg msg--reply msg--vote-reply ${rpc.voteGranted ? 'is-yes' : 'is-no'}`} transform={tr} r={5} />;
    case 'AppendEntriesReply':
      return <circle className={`msg msg--reply msg--ae-reply ${rpc.success ? 'is-yes' : 'is-no'}`} transform={tr} r={5} />;
  }
}
